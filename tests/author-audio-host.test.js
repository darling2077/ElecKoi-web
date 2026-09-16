import { describe, expect, it } from 'vitest';
import { AuthorAudioHost } from '../src/renderer/src/modules/authorFrontend/model/authorAudioHost.js';

class FakeAudio {
  constructor() {
    this.currentTime = 0;
    this.duration = 120;
    this.volume = 1;
    this.muted = false;
    this.src = '';
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener();
  }

  async play() { this.dispatch('play'); }
  pause() { this.dispatch('pause'); }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

describe('author audio host', () => {
  it('keeps host playback alive across callers and publishes state changes', async () => {
    const events = [];
    const audio = new FakeAudio();
    const host = new AuthorAudioHost(() => audio, (event) => events.push(event));

    const playing = await host.invoke('chat-1', 'audio.play', {
      channel: 'bgm', track: { id: 'theme', url: 'https://example.com/theme.mp3', name: 'Theme' }, loop: true,
    });
    expect(playing).toMatchObject({ conversationId: 'chat-1', channel: 'bgm', status: 'playing', currentTrack: { id: 'theme' }, loop: true });

    const paused = await host.invoke('chat-1', 'audio.pause', { channel: 'bgm' });
    expect(paused.status).toBe('paused');
    const resumed = await host.invoke('chat-1', 'audio.resume', { channel: 'bgm' });
    expect(resumed.status).toBe('playing');
    const sought = await host.invoke('chat-1', 'audio.seek', { channel: 'bgm', seconds: 35 });
    expect(sought.currentTime).toBe(35);
    expect(events.some((event) => event.name === 'audio.time.updated')).toBe(true);
  });

  it('supports playlists, automatic next track, and combined host volume', async () => {
    const audio = new FakeAudio();
    const host = new AuthorAudioHost(() => audio, () => {});
    await host.invoke('chat-1', 'audio.setPlaylist', {
      channel: 'ambient',
      items: ['https://example.com/rain.mp3', { id: 'wind', url: 'https://example.com/wind.ogg' }],
      autoplay: true,
    });
    audio.dispatch('ended');
    await Promise.resolve();
    expect((await host.invoke('chat-1', 'audio.getState', { channel: 'ambient' })).currentTrack.id).toBe('wind');

    const settings = await host.invoke('chat-1', 'audio.setSettings', {
      settings: { masterVolume: 0.5, channels: { ambient: { volume: 0.4 } } },
    });
    expect(settings.channels.ambient.volume).toBe(0.4);
    expect(audio.volume).toBeCloseTo(0.2);
  });
});
