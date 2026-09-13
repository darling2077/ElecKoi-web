# AGPL-3.0 与 GitHub fork 机制：事实调研报告

调研日期：2026-09-13。所有 URL 均已实际抓取验证。
凡标注「官方确认」的结论均来自一手官方文档/许可证文本；标注「社区」的来自论坛、博客或个人文章。
本地仓库现状核查基于 `/root/eleckoi` 当日实际状态。

---

## 一、AGPL-3.0 §13（Remote Network Interaction）

### 1.1 条文原文（官方确认）

> Notwithstanding any other provision of this License, **if you modify the Program**, your modified version must **prominently offer** all users interacting with it remotely through a computer network (if your version supports such interaction) **an opportunity to receive the Corresponding Source of your version** by providing access to the Corresponding Source from **a network server** at **no charge**, through some standard or customary means of facilitating copying of software.

来源：<https://www.gnu.org/licenses/agpl-3.0.en.html>

拆解为五个硬性要件：①仅在你**修改了**程序时触发；②必须**醒目地（prominently）**提供；③对象是**所有**通过计算机网络远程交互的使用者；④提供的是**你那个版本**的对应源码（不是上游的）；⑤方式必须是从**网络服务器**免费获取。

### 1.2 "Corresponding Source" 的确切范围（官方确认）

AGPL §1 定义：

> The "Corresponding Source" for a work in object code form means **all the source code needed to generate, install, and (for an executable work) run the object code and to modify the work, including scripts to control those activities.** However, it does not include the work's System Libraries, or general-purpose tools or generally available free programs which are used unmodified in performing those activities but which are not part of the work.

来源：<https://www.gnu.org/licenses/agpl-3.0.en.html>

FSF 官方 FAQ 明确此定义适用于 §13：

> "Corresponding Source" is defined in section 1 of the license, and you should provide what it lists. So, if your modified version depends on libraries under other licenses, such as the Expat license or GPLv3, the Corresponding Source should include those libraries (unless they are System Libraries). If you have modified those libraries, you must provide your modified source code for them.

来源：<https://www.gnu.org/licenses/gpl-faq.html#AGPLv3CorrespondingSource>

**对 Docker 部署的直接含义**：Dockerfile、compose 文件、构建脚本、启动脚本、入口配置属于"generate, install... and to modify"所需材料，落在对应源码范围内。

### 1.3 触发条件的边界（官方确认）

FSF FAQ：「interacting with [the software] remotely through a computer network」指

> If the program is expressly designed to accept user requests and send responses over a network, then it meets these criteria. Common examples of programs that would fall into this category include **web and mail servers, interactive web-based applications**, and servers for games that are played online.

并明确反向边界：仅仅因为用户通过 SSH 或远程 X session 运行**不属于**此类。

来源：<https://www.gnu.org/licenses/gpl-faq.html#AGPLv3InteractingRemotely>

FAQ 亦确认「把 AGPL 程序改成网站对外提供服务」必须发布修改后的源码：

> The GNU Affero GPL requires that modified versions of the software offer all users interacting with it over a computer network an opportunity to receive the source. What the company is doing falls under that meaning, so the company must release the modified source code.

来源：<https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL>

**注意**：§13 的义务主体是"修改者"。若另有第三方把未修改的 AGPL 程序挂到代理后面，该代理方不因 §13 而负担开源的作为义务——这是社区讨论中反复出现的规避路径（<https://www.lesswrong.com/posts/GGyt3EqtXGZ4rvDac/does-the-agpl-work>，社区观点，非官方）。但本项目**已经修改**，因此不在这一豁免范围内。

### 1.4 "提供"的合规做法

**（a）页面上放源码链接——这是 FSF 官方明文举例的做法（官方确认）**

AGPL 正文末尾 "How to Apply These Terms" 段：

> If your software can interact with users remotely through a computer network, you should also make sure that it provides a way for users to get its source. For example, if your program is a web application, **its interface could display a "Source" link that leads users to an archive of the code.** There are many ways you could offer source, and different solutions will be better for different programs; see section 13 for the specific requirements.

来源：<https://www.gnu.org/licenses/agpl-3.0.en.html>

GNU 官方 how-to 页重复同一建议：

> If you are releasing your program under the GNU AGPL, and it can interact with users over a network, the program should offer its source to those users in some way. For example, if your program is a web application, **its interface could display a "Source" link that leads users to an archive of the code.**

来源：<https://www.gnu.org/licenses/gpl-howto.html>（The Affero notice 节）

**结论**：界面上放"源码"链接是 FSF 自己举的示例做法，属于「足够」的通行实践，但法规要求的是"提供获取对应源码的机会（an opportunity to receive）"，不是"贴一个链接"这个动作本身——链接必须真的指向**你运行的这一版**的完整可构建源码，且要醒目。

**（b）如何向"所有用户"提供（官方确认）**

FAQ 就代理服务器场景给出方法：

> For software on a proxy server, you can provide an offer of source through a normal method of delivering messages to users of that kind of proxy. For example, a Web proxy could use a landing page. When users initially start using the proxy, you can direct them to a page with the offer of source... The AGPL says you must make the offer to "all users." If you know that a certain user has already been shown the offer, for the current version of the software, you don't have to repeat it to that user again.

来源：<https://www.gnu.org/licenses/gpl-faq.html#AGPLProxy>

即：**登录页/落地页放置源码入口即可满足"对所有用户"**，且对同一版本无需重复提示。

**（c）用版本库链接代替源码包——FSF 有条件接受（官方确认）**

> This is acceptable as long as the source checkout process does not become burdensome or otherwise restrictive. Anybody who can download your object code should also be able to check out source from your version control system, using a publicly available free software client. Users should be provided with **clear and convenient instructions for how to get the source for the exact object code they downloaded**—they may not necessarily want the latest development code, after all.

来源：<https://www.gnu.org/licenses/gpl-faq.html#SourceInCVS>

### 1.5 「是否必须提供含补丁的完整可构建源码树」——是（官方确认）

这是本报告中最关键、也最容易做错的一条。FSF FAQ 有两则直接回答：

**（1）只给 diff 不够：**

> This is a well-meaning request, but this method of providing the source doesn't really do the job. A user that wants the source a year from now may be unable to get the proper version from another site at that time. The standard distribution site may have a newer version, but the same diffs probably won't work with that version. **So you need to provide complete sources, not just diffs**, with the binaries.

来源：<https://www.gnu.org/licenses/gpl-faq.html#DistributingSourceIsInconvenient>

**（2）只给上游原始源码不够：**

> No, you must supply the source code that corresponds to the binary. **Corresponding source means the source from which users can rebuild the same binary.** ... Those using your version should have access to the source code for your version.

来源：<https://www.gnu.org/licenses/gpl-faq.html#DistributeExtendedBinary>

**（3）不要求二进制哈希级可复现，但要求"能构建、能修改"：**

> Complete corresponding source means the source that the binaries were made from, but that does not imply your tools must be able to make a binary that is an exact hash of the binary you are distributing.

来源：<https://www.gnu.org/licenses/gpl-faq.html#MustSourceBuildToMatchExactHashOfBinary>

**权威法律实务解读（第三方，非 FSF）**，Software Freedom Law Center《GPL Compliance Guide》第 2 版：

> "corresponding" source means **the source code, build scripts, makefiles, configuration files and other materials necessary to build a version of the program precisely equivalent to the executable delivered, to modify that source code, and to build the modified version.** Lacking anything necessary to build the precise version delivered means the source distributed is incomplete and not "corresponding."

来源：<https://softwarefreedom.org/resources/2014/SFLC-Guide_to_GPL_Compliance_2d_ed.html>

**对本项目的推论**：`patches/` 里的两个 `.patch` 是**构建输入**而非交付源码。用户若只拿到「上游 tarball + 两个 patch 文件」，需要自行 `git apply`，属于"burdensome or otherwise restrictive"的灰区；最稳妥的形态是发布一个**已含全部改动、开箱可构建的完整源码树**（例如打上补丁后的分支/tag，或随 release 附一份完整源码 tarball），同时**额外**保留 patches 目录以维持可审计性。两者不冲突：patch 目录是给维护者看的审计材料，完整源码树才是给用户的合规交付物。

### 1.6 标注修改 / 保留版权声明 / 附许可全文，分别出自哪一条（官方确认）

均出自 **AGPL-3.0 正文**（与 GPLv3 同文，仅 §13 不同）：

| 要求 | 出处 | 原文 |
|---|---|---|
| 标注「你修改过」并给出日期 | **§5(a)** | "The work must carry prominent notices stating that you modified it, and giving a relevant date." |
| 标注「本作品以本许可发布」 | **§5(b)** | "The work must carry prominent notices stating that it is released under this License and any conditions added under section 7. This requirement modifies the requirement in section 4 to 'keep intact all notices'." |
| 整体以 AGPL 授权 | **§5(c)** | "You must license the entire work, as a whole, under this License to anyone who comes into possession of a copy." |
| 保留版权声明、许可声明、免责声明 | **§4** | "conspicuously and appropriately publish on each copy an appropriate copyright notice; keep intact all notices stating that this License ... apply to the code; keep intact all notices of the absence of any warranty" |
| 随附许可全文 | **§4** | "and give all recipients a copy of this License along with the Program." |
| 交互界面显示 Appropriate Legal Notices | **§5(d)** | "If the work has interactive user interfaces, each must display Appropriate Legal Notices; however, if the Program has interactive interfaces that do not display Appropriate Legal Notices, your work need not make them do so." |

全部来源：<https://www.gnu.org/licenses/agpl-3.0.en.html>

**重要解读**：§5(d) 有"继承豁免"——上游 Electron 桌面应用若其界面本就未显示 Appropriate Legal Notices，你的 Web 版**不必**新增。但 §13 的源码提供义务**不因 §5(d) 豁免而消失**，二者是独立条款。

**关于"必须在每个文件头加许可声明"**：FSF 官方 FAQ 的措辞是"Why *should* I"而非"must"，属于最佳实践而非硬性条款：

> You should put a notice at the start of each source file, stating what license it carries, in order to avoid risk of the code's getting disconnected from its license.

来源：<https://www.gnu.org/licenses/gpl-faq.html#NoticeInSourceFile>

**关于"仅在仓库里放一份 LICENSE 够不够"**——FSF 认为不够明确：

> Just putting a copy of the GNU GPL in a file in your repository does not explicitly state that the code in the same repository may be used under the GNU GPL. Without such a statement, it's not entirely clear that the permissions in the license really apply to any particular source file.

来源：<https://www.gnu.org/licenses/gpl-faq.html#LicenseCopyOnly>

---

## 二、GitHub fork 机制的限制

### 2.1 fork 是否被排除在搜索结果之外（官方确认）

GitHub 官方文档开篇原句：

> **By default, forks are not shown in search results.** You can choose to include them in repository searches, and in code searches if they meet certain criteria.

- 仓库搜索：加 `fork:true`（含 fork）或 `fork:only`（仅 fork）
- 代码搜索：用 `is:fork` 包含；用 `NOT is:fork` 排除

来源：<https://docs.github.com/en/search-github/searching-on-github/searching-in-forks>

**关于"降权（down-ranked）"**：**未找到权威来源**。官方文档只表述为"默认不显示"，全文没有任何关于排名权重（ranking / relevance）的表述。任何"fork 会被降权"的说法均为推断。

### 2.2 fork 的默认分支与上游的关系（官方确认）

- fork 时默认复制上游仓库的**全部分支**；也可勾选 **"Copy the DEFAULT branch only"** 只复制默认分支。fork 的默认分支即上游 fork 时刻的默认分支。
- fork 的默认分支**可以独立改名/切换**——fork 是"a separate repository with its own settings"，拥有自己的 Branches、Tags、Actions 等。
- 与上游同步需要手动操作（配置 upstream remote 后 `git fetch upstream` / `git merge upstream/main`），GitHub 不会自动同步。

来源：<https://docs.github.com/en/pull-requests/how-tos/work-with-forks/fork-a-repo>、
<https://docs.github.com/en/pull-requests/reference/forks>、
<https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork>

### 2.3 fork 能否设为私有 / 私有 fork 的可见性规则（官方确认）

官方文档原句（逐字）：

> **A fork's visibility is tied to the upstream repository's repository network. Public repository forks are public, and private repository forks are private. You cannot change the visibility of a fork by itself.**
>
> All repositories in a repository network share the same visibility setting. A repository network includes the upstream repository, its forks, and forks of those forks.

来源：<https://docs.github.com/en/pull-requests/reference/forks>

补充规则（官方确认）：

- 私有仓库的 fork **继承上游的权限结构**（仅团队权限，非个人权限）。
- 不能把私有仓库 fork 到使用 GitHub Free 的组织。
- 可见性变更会使 fork 分裂成新的仓库网络：公开仓转私有 → 其公开 fork 留在独立的公开网络中；私有仓转公开 → 私有 fork 保持私有并断开为独立私有网络。
- 删除公开仓库时，一个活跃的公开 fork 会成为该网络的新上游。

来源：同上。

**对本项目的直接结论**：由于上游 `eleckoi/ElecKoi` 是**公开**仓库，**fork 出来的仓库必定是公开的，无法设为私有**。若你们想先私有开发再公开，fork 路线直接不可行。

### 2.4 fork 网络 vs「独立仓库+导入上游代码」在 GitHub 上的 diff 呈现差异

**官方确认的事实：**

- fork 会在仓库名下方显示 `forked from OWNER/REPO` 横幅，并保留 `parent` / `source` 关系；仓库页提供 "Sync fork" 按钮。
- 独立仓库没有上述横幅与同步入口，GitHub 不记录任何上游关系。
- GitHub Importer 的官方定位是"从**其他 Git 托管服务**导入"，导入的是"source code and commit history"，**不建立** fork 关系。

来源：<https://docs.github.com/en/pull-requests/reference/forks>、
<https://docs.github.com/en/migrations/importing-source-code/using-github-importer/about-github-importer>、
<https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/about-source-code-imports-using-the-command-line>

**关于"非 fork 仓库能否方便地展示与上游的差异"**：**官方未提供任何专门机制**。核心限制在 GitHub Branches 参考页有明文：

> A two-dot diff compares two Git committish references, such as SHAs or OIDs (Object IDs), directly with each other. **On GitHub, the Git committish references in a two-dot diff comparison must be pushed to the same repository or its forks.**

来源：<https://docs.github.com/en/pull-requests/reference/branches>

这是 doc 层面最强的限制陈述。但**实测结果比文档更宽松**，见 2.5。

### 2.5 跨仓库 compare：`github.com/OWNER/REPO/compare/upstream:main...main` 是否可用

用户提到的形式为 `UPSTREAM:main...main`。语法上 GitHub 支持 `OWNER:BRANCH` 形式的 owner-qualified 引用（官方确认）：

> You can also edit the URL directly. For example, use `octocat:main` as `base` and `octo-org:main` as `compare` to compare the `main` branches of repositories owned by `octocat` and `octo-org`.

来源：<https://docs.github.com/en/pull-requests/how-tos/commit-changes/comparing-commits>（Comparing across forks 节）

**实测（2026-09-13，直接抓取 compare 页面的渲染结果）：**

| 测试 URL | 结果 |
|---|---|
| `github.com/glitch-soc/mastodon/compare/main...mastodon:main` | ✅ 成功，显示 "10 files changed" |
| `github.com/glitch-soc/mastodon/compare/mastodon:main...main` | ✅ 成功（302 → 渲染正常） |
| `github.com/mastodon/mastodon/compare/main...glitch-soc:main` | ✅ 成功 |
| `github.com/eleckoi/ElecKoi/compare/main...octocat:main` | ❌ "There isn't anything to compare" |
| `github.com/yt-dlp/yt-dlp/compare/master...ytdl-org:master` | ❌ 同上 |
| `github.com/nextcloud/server/compare/master...owncloud:master` | ❌ 同上 |
| `github.com/torvalds/linux/compare/master...octocat:master` | ❌ 同上 |

**★ compare 页存在三种状态，必须分开识别（实测）：**

1. `OK` —— 正常渲染，页面上出现 "N files changed"
2. `TOO-LARGE` —— 页面上出现 **"This comparison is taking too long to generate. Unfortunately it looks like we can't render this comparison for you right now. It might be too big..."**。**这是合法的 compare（引用有效），只是超出渲染上限**——绝不能误判为"不可比"。
3. `NOTHING` —— 页面上出现 **"There isn't anything to compare. We couldn't figure out how to compare these references, do they point to valid commits?"** 这才是真正的失败。

**我的实测结论（并推翻了"只要共享 Git 历史即可跨网络 compare"的说法）：**

| 场景 | 结果 |
|---|---|
| glitch-soc/mastodon ↔ mastodon/mastodon（**同 fork 网络**） | ✅ OK（另一时段复测为 TOO-LARGE，同属"有效引用"） |
| hometown-fork/hometown ↔ mastodon/mastodon（**同 fork 网络**） | ❌ NOTHING（因 hometown 默认分支为 `hometown-dev`，`main` 引用无效） |
| torvalds/linux ↔ raspberrypi/linux:rpi-6.12.y（**跨网络，共享完整 Git 历史**） | ❌ **NOTHING**（两种语法 `raspberrypi:rpi-6.12.y` 与 `raspberrypi/linux:rpi-6.12.y` 均失败） |
| torvalds/linux ↔ gregkh:linux-6.6.y（跨网络，共享历史） | ❌ NOTHING |
| yt-dlp ↔ ytdl-org/youtube-dl（跨网络） | ❌ NOTHING |
| nextcloud/server ↔ owncloud/core（跨网络） | ❌ NOTHING |
| eleckoi/ElecKoi ↔ octocat/Spoon-Knife（无关） | ❌ NOTHING |

**因此：跨 fork 网络的仓库之间，即使共享完整 Git 历史（raspberrypi/linux 派生自 torvalds/linux），compare 依然返回 NOTHING。**"共享历史即可跨网络 compare"的说法**经实测证伪**（该说法来自一个已被我核查并否定的中间结论，记录在此以防误用）。可用性边界与官方文档一致：**`same repository or its forks`**。

**对本项目的直接含义**：若走「独立仓库 + 导入上游代码」路线，**不能依赖 GitHub compare 视图向外界展示"我们相对上游改了什么"**——该视图在非 fork 网络内不可用。需要改用其他方式呈现差异（如仓库内维护 CHANGELOG/差异文档、或在 release notes 中说明），或在 fork 网络内完成对比后再脱离。

**文档层面的权威边界**：官方文档只承诺"Comparing across forks"，**没有**为"任意两个仓库之间 compare"提供任何保证。故对本项目而言，**依赖 GitHub compare 视图来展示与上游的差异是不可靠的**——尤其如果采用 squash/rebase 式导入导致历史断裂。

**状态码陷阱**：所有 compare 页无论成功失败均返回 HTTP 404 或 200 不一致，**不能用 HTTP 状态码判断是否可比**，必须解析页面文案（`There isn't anything to compare` / `taking too long to generate` / `N files changed`）三态。

### 2.6 脱离 fork 网络（官方确认 — 重要更新）

GitHub **现已提供官方自助功能**，不再需要发 Support 工单：

> To turn your fork into a standalone repository, you can leave the fork network. ... This is useful when you want to take your work in a different direction or maintain distinct versions.

路径：**Settings → General → Danger Zone → Leave fork network**

适用条件（官方明列）：
- fork 必须是 **public**
- fork 必须 **小于 1GB**
- fork **没有任何 child forks**

代价（官方 Warning）：
- 新仓库**不会保留** issues、pull requests、wikis、stars、watchers、comments、child forks 等元数据（git commit 元数据保留）
- **"Leaving the fork network is permanent and the new repository cannot be reconnected to the fork network."**

官方亦给出降级方案（Manually leaving the fork network）：`git clone --bare` → 删除 fork → 新建同名仓库 → push，代价是永久删除关联 PR 与配置。

来源：<https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork>

**社区背景**：长期存在的诉求 [isaacs/github#1504 "Detach fork but keep fork symbol and link"](https://github.com/isaacs/github/issues/1504)（2019-02-28 提出，仓库已于 2021-11-18 归档为只读）要求"脱离但保留 fork 标识与上游链接"——**该诉求至今未实现**，官方方案只有"完全切断、不可回连、丢失元数据"。相关社区讨论：<https://github.com/orgs/community/discussions/52663>、<https://github.com/orgs/community/discussions/59046>（均为社区内容，非官方）。

---

## 三、GitHub 上「基于 fork 的衍生发行版」的真实做法

### 3.0 一个颠覆直觉的实测发现

我用两种可复核方法检测了约 60 个著名"下游 fork"候选仓库：
1. GitHub 页面元数据中的 `isFork` / `parentRepo` 字段；
2. 渲染页中**真正的 fork 横幅**——真横幅的 HTML 含 `data-hovercard-url="/OWNER/REPO/hovercard"`，而 README 正文里写的 "forked from ..." **不带**该属性（二者极易混淆）。

**结果：绝大多数著名下游发行版根本不在 GitHub fork 网络内。**

**不在 fork 网络内（`isFork: false`，独立仓库）**：yt-dlp、OpenTofu、Valkey、Gitea、Jellyfin、Nextcloud、KeePassXC、OpenSearch、OpenBao、Neovim、Homebrew/brew、ohmyzsh、LibreOffice、MariaDB、Percona、TiDB、TimescaleDB、Tasmota、Marlin、Klipper、VSCodium、Strawberry↔Clementine，以及 Linux Mint / Cinnamon / MATE / EndeavourOS / Manjaro / Arco / Pop!_OS 的全部相关仓库。

**只有 2 个仍在 fork 网络内且长期维护的下游**：Git for Windows、Adafruit CircuitPython。

### 3.1 案例一：Git for Windows（在 fork 网络内）

- fork：<https://github.com/git-for-windows/git> ｜ 上游：<https://github.com/git/git>
- **GitHub 显示 `forked from git/git`**（实测横幅含 `data-hovercard-url="/git/git/hovercard"`）。
- **关系标注方式**：① fork 网络横幅本身即机器可读的关系声明；② README 首句明示定位——"This is Git for Windows, the Windows port of Git."（<https://github.com/git-for-windows/git/blob/main/README.md>）。
- **许可证**：上游与 fork 均为 **GPL-2.0**。这是"强 copyleft 上游 + 长期维护下游 fork"的范例，与本项目情形最接近。

### 3.2 案例二：Adafruit CircuitPython（在 fork 网络内）

- fork：<https://github.com/adafruit/circuitpython> ｜ 上游：<https://github.com/micropython/micropython>
- **GitHub 显示 `forked from micropython/micropython`**（实测确认）。
- **关系标注方式**：README 明确写 "CircuitPython is based on MicroPython"，并专设 **"Differences from Micropython"** 章节说明分歧（<https://github.com/adafruit/circuitpython/blob/main/README.rst>）。
- **许可证**：双方均 MIT。

### 3.3 案例三：MisskeyIO/misskey（在 fork 网络内 + AGPL-3.0 + 多用户网络服务 —— **与本项目最可类比**）

- fork：<https://github.com/MisskeyIO/misskey> ｜ 上游：<https://github.com/misskey-dev/misskey>
- **GitHub 显示 `forked from misskey-dev/misskey`**（实测横幅 + `parentRepo` 确认）。
- **许可证**：AGPL-3.0（实测 `license.spdxId: AGPL-3.0`），上游同为 AGPL-3.0。
- 这是一个"AGPL 网络服务项目在 fork 上做本地化/衍生分发并长期维护"的现成先例。

### 3.4 关键反例：yt-dlp（刻意不在 fork 网络内）

- 下游：<https://github.com/yt-dlp/yt-dlp> ｜ 上游：<https://github.com/ytdl-org/youtube-dl>
- **实测 `fork: false`，`parent`/`source` 均为 `null`，无任何 fork 横幅。** 其页面上出现的 "Forked from yt-dlc@f9401f2" 是 **README 正文文本**，不是 fork 关系声明。
- **关系标注方式**：纯文档声明——README 写 "The project is a fork of youtube-dl based on the now inactive youtube-dlc"（<https://github.com/yt-dlp/yt-dlp/blob/master/README.md>），并有专门的 Wiki 页面《Forks》列出谱系（<https://github.com/yt-dlp/yt-dlp/wiki/Forks>）。
- **关于"刻意脱离 fork 网络"的动机**：**未找到权威来源**，只能确证其客观状态。

### 3.5 值得参考的对照：glitch-soc（Mastodon 下游，AGPL-3.0，在 fork 网络内）

- fork：<https://github.com/glitch-soc/mastodon> ｜ 上游：<https://github.com/mastodon/mastodon>，双方均 **AGPL-3.0**（实测）。
- **在 fork 网络内**（实测 `parentRepo: mastodon/mastodon`），且实测 `compare/main...mastodon:main` **可用**（显示 10 files changed）。
- **关系标注方式**：README 开头写 "Mastodon Glitch Edition is a fork of [Mastodon]. **Upstream's README file is reproduced below.**"，然后原样附上上游 README——即"自己的说明 + 完整保留上游 README"的双层结构。这是 AGPL 下游 fork 标注关系的清晰范例。

### 3.6 官方文档层面

GitHub **没有**一篇专门对比"fork vs 独立仓库+导入历史"的取舍指南——**未找到权威来源**。官方只有分别描述两条路径能力与限制的页面（见 2.4）。"下游发行版该选哪种"的决策建议属于社区经验，无官方背书。

---

## 四、GitHub Actions 在 fork 上的额度与限制

### 4.1 公开仓库的 Actions 是否免费（官方确认）

官方原句：

> GitHub Actions usage is **free** for **self-hosted runners** and for **public repositories** that use standard GitHub-hosted runners.

来源：<https://docs.github.com/en/actions/concepts/billing-and-usage>、
<https://docs.github.com/en/billing/concepts/product-billing/github-actions>

**注意旧链接已失效**：`https://docs.github.com/en/billing/managing-billing-for-your-github-actions/about-billing-for-github-actions` 现返回 **404**，内容已迁移至上列地址。

### 4.2 fork 仓库的 Actions 默认是否禁用（官方确认 + 官方 Issue 佐证）

官方文档原句（在 `pull_request` 事件说明中）：

> **Workflows don't run in forked repositories by default. You must enable GitHub Actions in the Actions tab of the forked repository.**

来源：<https://docs.github.com/en/actions/reference/events-that-trigger-workflows>

fork 后 Actions 页会显示横幅（官方 issue 中逐字引用了该 UI 文案）：

> **Workflows aren't being run on this forked repository**
> Because this repository contained workflow files when it was forked, we have disabled them from running on this fork. Make sure you understand the configured workflows and their expected usage before enabling Actions on this repository.

来源：<https://github.com/github/docs/issues/15761>（GitHub 官方文档仓库的 issue，UI 文案为官方产品文案）

**scheduled（定时）workflow**（官方原句）：

> To prevent unnecessary workflow runs, scheduled workflows may be disabled automatically. **When a public repository is forked, scheduled workflows are disabled by default.** In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.

来源：<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows>

**社区注意点（非官方）**：有用户报告"往 fork 推送新增/修改过的 workflow 文件会静默地自动启用 Actions，绕过该 interstitial"（<https://github.com/orgs/community/discussions/53510>）；也有 2026 年的反馈称该默认禁用行为在实际使用中未必稳定出现（<https://github.com/orgs/community/discussions/26704>）。**不依赖此机制做安全边界。**

### 4.3 fork PR 触发的 workflow 与 secrets（官方确认）

> With the exception of `GITHUB_TOKEN`, **secrets are not passed to the runner** when a workflow is triggered from a forked repository. The `GITHUB_TOKEN` has **read-only permissions** in pull requests from forked repositories.

来源：<https://docs.github.com/en/actions/reference/events-that-trigger-workflows>

审批默认值（官方原句）：

> **By default, all first-time contributors require approval to run workflows.**

三档可选项（官方命名，注意措辞）：
- `Require approval for first-time contributors who are new to GitHub`
- `Require approval for first-time contributors`
- `Require approval for all external contributors`（**不是** "all outside collaborators"）

来源：<https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository>、
<https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks>

另：等待审批超过 30 天的 workflow run 会被自动删除（来源同上 approve-runs-from-forks）。

### 4.4 私有仓库的免费额度（官方确认）

| 计划 | Actions 分钟/月 | artifact 存储 | cache 存储（每仓库） |
|---|---|---|---|
| GitHub Free（个人） | 2,000 | 500 MB | 10 GB |
| GitHub Pro | 3,000 | 1 GB | 10 GB |
| GitHub Free（组织） | 2,000 | 500 MB | 10 GB |
| GitHub Team | 3,000 | 2 GB | 10 GB |
| GitHub Enterprise Cloud | 50,000 | 50 GB | 10 GB |

来源：<https://docs.github.com/en/billing/reference/product-usage-included>、
<https://docs.github.com/en/billing/concepts/product-billing/github-actions>

### 4.5 运行上限（官方确认）

- **每个 job 最长 6 小时**（GitHub-hosted runner）；self-hosted 为 5 天
- **每次 workflow run 最长 35 天**（含执行、等待与审批时间）
- 环境审批最多等待 30 天
- job matrix 每次最多 256 个 job；单次 run 最多重跑 50 次

来源：<https://docs.github.com/en/actions/reference/limits>

---

## 五、许可证合规清单（AGPL-3.0 衍生作品发布到 GitHub）

### 5.1 硬性条款（全部来自 AGPL-3.0 正文，官方确认）

| # | 要求 | 出处 |
|---|---|---|
| 1 | 保留上游版权声明（不得删除） | §4 |
| 2 | 保留许可声明与免责声明 | §4 |
| 3 | 随作品附带 AGPL 全文（LICENSE 文件） | §4 |
| 4 | **醒目注明"你修改过"并给出相关日期** | §5(a) |
| 5 | 醒目注明本作品以本许可发布 | §5(b) |
| 6 | 整个作品整体以 AGPL 授权 | §5(c) |
| 7 | 交互界面显示 Appropriate Legal Notices（上游未显示则可豁免） | §5(d) |
| 8 | **§13：向所有网络用户醒目提供对应源码的网络获取途径，免费** | §13 |

来源：<https://www.gnu.org/licenses/agpl-3.0.en.html>

### 5.2 FSF 官方 FAQ 的补充口径

- 源码须完整、须对应你所运行的那个版本，**diff 不够**（<https://www.gnu.org/licenses/gpl-faq.html#DistributingSourceIsInconvenient>、<https://www.gnu.org/licenses/gpl-faq.html#DistributeExtendedBinary>）
- 依赖库若被修改也须一并提供（<https://www.gnu.org/licenses/gpl-faq.html#AGPLv3CorrespondingSource>）
- 不要求二进制哈希级可复现（<https://www.gnu.org/licenses/gpl-faq.html#MustSourceBuildToMatchExactHashOfBinary>）
- 版本库链接可接受，但取源码过程不得繁琐、且须有清晰指引指向**用户下载的那一份**源码（<https://www.gnu.org/licenses/gpl-faq.html#SourceInCVS>）
- 仅在仓库放一份 LICENSE 不足以明确授权范围，需有明确声明（<https://www.gnu.org/licenses/gpl-faq.html#LicenseCopyOnly>）

### 5.3 违规的后果（社区权威解读，非 FSF 官方）

软件自由保护协会（Software Freedom Conservancy）就 AGPL 网络服务违规的解读：

> To comply with this important FOSS license, Trump's Group needs to immediately make that Corresponding Source available to all who used the site today while it was live. **If they fail to do this within 30 days, their rights and permissions in the software are automatically and permanently terminated.**

来源：<https://sfconservancy.org/blog/2021/oct/21/trump-group-agplv3>（该文作者 Bradley M. Kuhn 为 AGPL §13 条文的起草参与者之一，但仍属第三方解读）

对应许可正文条文为 **§8 Termination**（<https://www.gnu.org/licenses/agpl-3.0.en.html>）。

### 5.4 「是不是必须公开源码」的边界（官方确认）

- §13 **仅在你修改了程序时**触发；未修改地原样部署不触发 §13 的作为义务。
- 但一旦对外发布（convey）任何形态的副本，§4/§5/§6 的义务即生效。
- 组织内部使用不构成 distribution，也不触发公开义务（GPL 语境；AGPL 下 §13 仍以"修改+网络交互"为触发条件）。

来源：<https://www.gnu.org/licenses/gpl-faq.html#GPLRequireSourcePostedPublic>、
<https://www.gnu.org/licenses/gpl-faq.html#InternalDistribution>

---

## 六、对本项目仓库现状的实测核查（合规相关事实）

以下为当日对 `/root/eleckoi` 的实际检查结果，属于事实陈述：

1. **上游仓库**：`eleckoi/ElecKoi`，默认分支 `main`，许可证 **AGPL-3.0**，公开仓库（实测 `isFork: false`）。

2. **本地 remote 配置**：仅有 `upstream → https://github.com/eleckoi/ElecKoi.git`，**未配置 fork/origin remote**。

3. **工作树未提交改动**：
   - 已修改（tracked，` M`）：`package.json`、`src/main/platform/filesystem/LocalMediaStore.ts`、`src/renderer/src/modules/authorFrontend/components/RichMessageFrame.jsx`
   - 未跟踪（`??`）：`.dockerignore`、`docker/`、`docs/webui/`、`patches/`、`scripts/apply-patches.mjs`、`scripts/check-upstream-diff.mjs`、`src/web/`

4. **`patches/` 目录内容**：
   - `0001-local-media-path-separator.patch` → 改 `src/main/platform/filesystem/LocalMediaStore.ts`
   - `0002-cross-origin-card-frame.patch` → 改 `src/renderer/src/modules/authorFrontend/components/RichMessageFrame.jsx`
   - 两个 patch 的 +++/--- 行与上述两个已修改 tracked 文件**完全对应**。

5. **⚠️ 发现两处不一致，均与合规交付物完整性直接相关**：
   - **`package.json` 已被修改（+21 行 webui 脚本，共 22 行改动）但不被任何 patch 覆盖**（`grep -l "package.json" patches/*.patch` 无结果）。即：该改动目前只存在于未提交的工作树中。
   - **`patches/README.md` 的"当前补丁"一节仍写着「（暂无）」**，而其"预留给 M3 的候选"一节所描述的 `0001-rich-frame-sandbox.patch` 与实际存在的 `0002-cross-origin-card-frame.patch` 编号与命名均不符。该文件的登记纪律（"每增加一个补丁，必须在本文件登记"）尚未被执行。
   - 影响：若以当前状态生成"完整对应源码"，无法从 patch 集 + 上游 tarball 完整复现出实际运行的源码树。

6. **AGPL §13 源码入口在代码中已有实现**（实测存在）：
   - `src/web/http/loginPage.ts:26` — "本服务的对应源码地址。AGPL-3.0 §13 要求以网络提供服务时向使用者提供源码"
   - `src/web/stack.ts:27` — "AGPL §13 要求的对应源码地址"
   - `src/web/entry.ts:70` — 未配置 `ELECKOI_SOURCE_URL` 时打印告警
   - `src/web/poc/multiTenantCheck.ts:92` — 校验项"登录页带 AGPL §13 要求的对应源码入口"
   - `docs/webui/ElecKoi-Docker-WebUI-多用户方案.md:416` — "### 10.1 AGPL-3.0 §13（硬义务）"

7. **上游 `NOTICE` 文件**（`/root/eleckoi/NOTICE`）当前写有：
   > The corresponding source for released builds is published at: https://github.com/eleckoi/ElecKoi

   **注意**：该地址是**上游**仓库。若发布的是你们的改造版，按 §13 该指向必须改为**你们发布的那个版本**的对应源码地址（FSF FAQ #DistributeExtendedBinary："Those using your version should have access to the source code for your version"）。

8. **规模参考**：`src/web/` 64 个文件 / 896K；`docker/` 36K；`docs/webui/` 312K。

---

## 七、未找到权威来源的事项（明确列举）

| 事项 | 状态 |
|---|---|
| fork 仓库在搜索中被"降权（down-ranked）" | **未找到权威来源**。官方仅表述为"默认不显示"，无任何 ranking 表述。 |
| GitHub 官方关于"fork vs 独立仓库+导入历史"的取舍指南 | **未找到权威来源**。官方只有分别描述两条路径的文档，无对比性建议。 |
| 跨仓库 compare 是否被**正式保证**可用于非 fork 网络仓库 | **已实测否定**。跨网络仓库（含共享完整 Git 历史的 raspberrypi/linux ↔ torvalds/linux）一律返回 "There isn't anything to compare"。官方文档明文只保证 "same repository or its forks"，跨网络行为无承诺且实测不可用。 |
| GitHub "Leave fork network" 功能的具体上线日期/changelog | **未能核实**。仅确认该功能现已存在于官方文档。 |
| yt-dlp "刻意脱离 fork 网络"的官方动机说明 | **未找到权威来源**。仅能确证其客观状态（fork=false）。 |
| "链接触及合规下限即可"的官方量化标准 | **未找到权威来源**。FSF 用词为 "prominently"、"opportunity to receive"，无量化阈值。 |
