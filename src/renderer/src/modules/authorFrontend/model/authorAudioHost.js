import { AUTHOR_API_VERSION } from '@eleckoi/author-sdk';

export const authorAudioChannels = ['bgm', 'ambient', 'voice', 'sfx'];

const listeners = new Set();

function clamp(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function channelName(value) {
  const channel = value || 'bgm';
  if (!authorAudioChannels.includes(channel)) throw codedError('INVALID_PARAMS', `未知的音频频道：${String(channel)}`);
  return channel;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeTrack(value, fallbackId) {
  const source = typeof value === 'string' ? { url: value } : value;
  if (!source || typeof source !== 'object' || typeof source.url !== 'string' || !source.url.trim()) {
    throw codedError('INVALID_PARAMS', '音频曲目必须提供可读取的 url');
  }
  const url = source.url.trim();
  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : fallbackId,
    url,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : url.split('/').pop() || '音频',
    mimeType: typeof source.mimeType === 'string' ? source.mimeType : '',
    metadata: source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? source.metadata : {},
  };
}

function cloneState(entry) {
  const duration = Number(entry.audio.duration);
  return {
    conversationId: entry.conversationId,
    channel: entry.channel,
    status: entry.status,
    playlist: entry.playlist.map((item) => ({ ...item, metadata: { ...item.metadata } })),
    currentIndex: entry.currentIndex,
    currentTrack: entry.playlist[entry.currentIndex] ? { ...entry.playlist[entry.currentIndex], metadata: { ...entry.playlist[entry.currentIndex].metadata } } : null,
    currentTime: Number.isFinite(entry.audio.currentTime) ? entry.audio.currentTime : 0,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    loop: entry.loop,
    shuffle: entry.shuffle,
    volume: entry.volume,
    muted: entry.muted,
    error: entry.error,
  };
}

export class AuthorAudioHost {
  constructor(createAudio = () => new Audio(), emit = (event) => {
    for (const listener of listeners) listener(event);
  }) {
    this.createAudio = createAudio;
    this.emit = emit;
    this.entries = new Map();
    this.trackSequence = 0;
    this.settings = {
      masterVolume: 1,
      muted: false,
      channels: Object.fromEntries(authorAudioChannels.map((channel) => [channel, { volume: 1, muted: false }])),
    };
  }

  async invoke(conversationId, method, params = {}) {
    const channel = channelName(params.channel);
    switch (method) {
      case 'audio.play': {
        const entry = this.entry(channel, conversationId);
        entry.conversationId = conversationId;
        entry.playlist = [normalizeTrack(params.track, this.nextTrackId())];
        entry.currentIndex = 0;
        entry.loop = Boolean(params.loop);
        entry.volume = clamp(params.volume, 1);
        entry.muted = false;
        this.load(entry, Number(params.startAt) || 0);
        await this.start(entry);
        return cloneState(entry);
      }
      case 'audio.pause': {
        const entry = this.entry(channel, conversationId);
        entry.audio.pause();
        if (entry.status !== 'idle' && entry.status !== 'ended') entry.status = 'paused';
        this.publish('audio.state.changed', entry);
        return cloneState(entry);
      }
      case 'audio.resume': {
        const entry = this.entry(channel, conversationId);
        if (!entry.playlist[entry.currentIndex]) throw codedError('AUDIO_EMPTY', '当前音频频道没有可播放的曲目');
        entry.conversationId = conversationId;
        await this.start(entry);
        return cloneState(entry);
      }
      case 'audio.stop': {
        const entry = this.entry(channel, conversationId);
        entry.audio.pause();
        entry.audio.currentTime = 0;
        entry.status = 'idle';
        entry.error = '';
        this.publish('audio.state.changed', entry);
        return cloneState(entry);
      }
      case 'audio.seek': {
        const entry = this.entry(channel, conversationId);
        const seconds = Number(params.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) throw codedError('INVALID_PARAMS', '播放位置必须是非负秒数');
        const duration = Number(entry.audio.duration);
        entry.audio.currentTime = Number.isFinite(duration) ? Math.min(seconds, duration) : seconds;
        this.publish('audio.time.updated', entry);
        return cloneState(entry);
      }
      case 'audio.getState':
        return cloneState(this.entry(channel, conversationId));
      case 'audio.getPlaylist': {
        const entry = this.entry(channel, conversationId);
        return { channel, items: cloneState(entry).playlist, currentIndex: entry.currentIndex };
      }
      case 'audio.setPlaylist': {
        const entry = this.entry(channel, conversationId);
        const items = this.tracks(params.items);
        entry.conversationId = conversationId;
        entry.audio.pause();
        entry.playlist = items;
        entry.currentIndex = items.length ? Math.min(Math.max(Number.isInteger(params.currentIndex) ? params.currentIndex : 0, 0), items.length - 1) : -1;
        entry.loop = Boolean(params.loop);
        entry.shuffle = Boolean(params.shuffle);
        entry.error = '';
        if (!items.length) {
          entry.audio.removeAttribute('src');
          entry.status = 'idle';
        } else {
          this.load(entry, 0);
          if (params.autoplay) await this.start(entry);
          else entry.status = 'paused';
        }
        this.publish('audio.state.changed', entry);
        return cloneState(entry);
      }
      case 'audio.appendPlaylist': {
        const entry = this.entry(channel, conversationId);
        entry.conversationId = conversationId;
        const wasEmpty = entry.playlist.length === 0;
        entry.playlist.push(...this.tracks(params.items));
        if (wasEmpty && entry.playlist.length) {
          entry.currentIndex = 0;
          this.load(entry, 0);
          entry.status = 'paused';
        }
        this.publish('audio.state.changed', entry);
        return cloneState(entry);
      }
      case 'audio.getSettings':
        return this.publicSettings();
      case 'audio.setSettings':
        return this.setSettings(params.settings);
      default:
        return null;
    }
  }

  entry(channel, conversationId) {
    const existing = this.entries.get(channel);
    if (existing) {
      existing.conversationId = conversationId;
      return existing;
    }
    const audio = this.createAudio();
    const entry = {
      audio, channel, conversationId, status: 'idle', playlist: [], currentIndex: -1,
      loop: false, shuffle: false, volume: 1, muted: false, error: '', lastTimeEvent: 0, pendingStartAt: 0,
    };
    audio.preload = 'auto';
    audio.addEventListener('play', () => { entry.status = 'playing'; entry.error = ''; this.publish('audio.state.changed', entry); });
    audio.addEventListener('pause', () => {
      if (entry.status === 'playing' || entry.status === 'loading') entry.status = 'paused';
      this.publish('audio.state.changed', entry);
    });
    audio.addEventListener('loadedmetadata', () => {
      if (entry.pendingStartAt > 0) {
        const duration = Number(audio.duration);
        audio.currentTime = Number.isFinite(duration) ? Math.min(entry.pendingStartAt, duration) : entry.pendingStartAt;
        entry.pendingStartAt = 0;
      }
      this.publish('audio.state.changed', entry);
    });
    audio.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - entry.lastTimeEvent < 250) return;
      entry.lastTimeEvent = now;
      this.publish('audio.time.updated', entry);
    });
    audio.addEventListener('ended', () => { void this.advance(entry); });
    audio.addEventListener('error', () => {
      entry.status = 'error';
      entry.error = audio.error?.message || '音频加载或播放失败';
      this.publish('audio.state.changed', entry);
    });
    this.entries.set(channel, entry);
    this.applyVolume(entry);
    return entry;
  }

  tracks(value) {
    if (!Array.isArray(value) || value.length > 1_000) throw codedError('INVALID_PARAMS', '播放列表必须是曲目数组');
    return value.map((item) => normalizeTrack(item, this.nextTrackId()));
  }

  nextTrackId() {
    this.trackSequence += 1;
    return `audio-${Date.now()}-${this.trackSequence}`;
  }

  load(entry, startAt) {
    const track = entry.playlist[entry.currentIndex];
    if (!track) return;
    entry.status = 'loading';
    entry.error = '';
    entry.audio.src = track.url;
    entry.pendingStartAt = Math.max(0, startAt || 0);
    this.applyVolume(entry);
    entry.audio.load?.();
    if (entry.pendingStartAt > 0 && Number(entry.audio.readyState) >= 1) {
      const duration = Number(entry.audio.duration);
      entry.audio.currentTime = Number.isFinite(duration) ? Math.min(entry.pendingStartAt, duration) : entry.pendingStartAt;
      entry.pendingStartAt = 0;
    }
    this.publish('audio.state.changed', entry);
  }

  async start(entry) {
    entry.status = 'loading';
    this.applyVolume(entry);
    this.publish('audio.state.changed', entry);
    try {
      await entry.audio.play();
      entry.status = 'playing';
      entry.error = '';
      this.publish('audio.state.changed', entry);
    } catch (error) {
      entry.status = 'error';
      entry.error = error?.message || '浏览器没有允许音频播放';
      this.publish('audio.state.changed', entry);
      throw codedError('AUDIO_PLAY_FAILED', entry.error);
    }
  }

  async advance(entry) {
    if (!entry.playlist.length) return;
    if (entry.shuffle && entry.playlist.length > 1) {
      let next = entry.currentIndex;
      while (next === entry.currentIndex) next = Math.floor(Math.random() * entry.playlist.length);
      entry.currentIndex = next;
    } else if (entry.currentIndex + 1 < entry.playlist.length) {
      entry.currentIndex += 1;
    } else if (entry.loop) {
      entry.currentIndex = 0;
    } else {
      entry.status = 'ended';
      this.publish('audio.state.changed', entry);
      return;
    }
    this.load(entry, 0);
    try { await this.start(entry); } catch { /* the error state was already published */ }
  }

  applyVolume(entry) {
    const channel = this.settings.channels[entry.channel];
    entry.audio.volume = clamp(this.settings.masterVolume * channel.volume * entry.volume);
    entry.audio.muted = Boolean(this.settings.muted || channel.muted || entry.muted);
  }

  setSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw codedError('INVALID_PARAMS', '音频设置必须是对象');
    if (value.masterVolume !== undefined) this.settings.masterVolume = clamp(value.masterVolume);
    if (value.muted !== undefined) this.settings.muted = Boolean(value.muted);
    if (value.channels && typeof value.channels === 'object' && !Array.isArray(value.channels)) {
      for (const channel of authorAudioChannels) {
        const next = value.channels[channel];
        if (!next || typeof next !== 'object' || Array.isArray(next)) continue;
        if (next.volume !== undefined) this.settings.channels[channel].volume = clamp(next.volume);
        if (next.muted !== undefined) this.settings.channels[channel].muted = Boolean(next.muted);
      }
    }
    for (const entry of this.entries.values()) {
      this.applyVolume(entry);
      this.publish('audio.state.changed', entry);
    }
    return this.publicSettings();
  }

  publicSettings() {
    return {
      masterVolume: this.settings.masterVolume,
      muted: this.settings.muted,
      channels: Object.fromEntries(authorAudioChannels.map((channel) => [channel, { ...this.settings.channels[channel] }])),
    };
  }

  publish(name, entry) {
    this.emit({ name, payload: { conversationId: entry.conversationId, state: cloneState(entry) } });
  }
}

const audioMethods = new Set([
  'audio.play', 'audio.pause', 'audio.resume', 'audio.stop', 'audio.seek', 'audio.getState',
  'audio.getPlaylist', 'audio.setPlaylist', 'audio.appendPlaylist', 'audio.getSettings', 'audio.setSettings',
]);

const host = new AuthorAudioHost();

function success(id, result) {
  return JSON.stringify({ id, ok: true, result: result ?? null });
}

function failure(id, code, message) {
  return JSON.stringify({ id, ok: false, error: { code, message } });
}

export async function routeAuthorAudioRequest(rawRequest, conversationId) {
  let value;
  try { value = JSON.parse(rawRequest); } catch { return null; }
  if (!value || typeof value !== 'object' || !audioMethods.has(value.method)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) return failure('', 'INVALID_REQUEST', '请求 id 格式不正确');
  if (value.apiVersion !== AUTHOR_API_VERSION) return failure(id, 'UNSUPPORTED_VERSION', `不支持的 API 版本：${String(value.apiVersion || '')}`);
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? value.params : {};
  try {
    return success(id, await host.invoke(conversationId, value.method, params));
  } catch (error) {
    return failure(id, error?.code || 'AUDIO_ERROR', error?.message || '音频操作失败');
  }
}

export function subscribeAuthorAudioEvents(conversationId, listener) {
  const receive = (event) => {
    if (event.payload?.conversationId === conversationId) listener(event);
  };
  listeners.add(receive);
  return () => listeners.delete(receive);
}
