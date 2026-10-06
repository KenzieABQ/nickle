# Local Downloader

A small, local-only media downloader with a minimal desktop-style interface.
It runs entirely on your computer: a Node.js server on `localhost` drives
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/),
and saves files into this project's `downloads/` folder.

> Use it only for media you own or have permission to download. The app does
> not support sign-in, cookies, DRM, CAPTCHAs, proxies or any other way of
> getting around access restrictions.

---

## Features

- Paste a URL, click **Analyze** to see the thumbnail, title, uploader,
  duration and available resolutions.
- Download **Video** (Best available, 1080p, 720p, 480p, 360p) or
  **Audio only** (MP3 or M4A).
- Videos are saved as MP4 with H.264 video and AAC audio, so they play in
  QuickTime, on iPhone/iPad, and in every common player (see
  [Video compatibility](#video-compatibility)).
- Live progress: percentage, downloaded size, speed, time left, and the current
  stage (Preparing, Downloading, Processing, Complete).
- Cancel a running download. Partial files are removed.
- When a download finishes, open the file or show it in your file manager.
- Plain-language error messages in the UI. Full details go to the terminal.

---

## Setup

You need **Node.js 18.17 or newer**, **yt-dlp**, and **ffmpeg**.

### 1. Install Node.js

| OS | Command / steps |
| --- | --- |
| **macOS** | `brew install node`, or download the LTS installer from <https://nodejs.org> |
| **Windows** | `winget install OpenJS.NodeJS.LTS`, or download the LTS installer from <https://nodejs.org> |
| **Linux (Debian/Ubuntu)** | Use the LTS version from <https://nodejs.org/en/download> (nvm or NodeSource). Distro packages are often too old. |

Check it: `node --version` should print `v18.17.0` or higher.

### 2. Install yt-dlp

| OS | Command |
| --- | --- |
| **macOS** | `brew install yt-dlp` |
| **Windows** | `winget install yt-dlp.yt-dlp` |
| **Linux** | `python3 -m pip install -U yt-dlp` (or `pipx install yt-dlp`) |

On any OS you can also download the standalone binary from
<https://github.com/yt-dlp/yt-dlp/releases/latest> and put it on your `PATH`.

Check it: `yt-dlp --version`

> Websites change often. If a site that used to work stops working, update
> yt-dlp first: `yt-dlp -U` (standalone binary), `brew upgrade yt-dlp`,
> `winget upgrade yt-dlp.yt-dlp`, or `python3 -m pip install -U yt-dlp`.

### 3. Install ffmpeg

| OS | Command |
| --- | --- |
| **macOS** | `brew install ffmpeg` |
| **Windows** | `winget install Gyan.FFmpeg` |
| **Linux (Debian/Ubuntu)** | `sudo apt install ffmpeg` |
| **Linux (Fedora)** | `sudo dnf install ffmpeg` (RPM Fusion), or `ffmpeg-free` |

Check it: `ffmpeg -version`

> **Windows:** after installing with winget, close and reopen your terminal so
> the updated `PATH` is picked up.

### 4. Install the project dependencies

From this folder (`local-downloader/`):

```bash
npm install
```

### 5. Start the app

```bash
npm start
```

The app starts and opens **<http://localhost:3210>** in your browser. You
should see something like this in the terminal:

```
  Local Downloader
  --------------------------------------------
  Running at  http://localhost:3210
  Downloads   /path/to/local-downloader/downloads
  yt-dlp      2026.08.19
  ffmpeg      7.1
```

### 6. Open it in your browser

If the browser doesn't open by itself, go to **<http://localhost:3210>**.

Use `npm run serve` instead of `npm start` to start without opening a browser.

---

## Everyday use

Setup is done once. After that, starting the app is one double-click.

| OS | Double-click this file in the `local-downloader` folder |
| --- | --- |
| **macOS** | `Start Local Downloader.command` |
| **Windows** | `Start Local Downloader.bat` |
| **Linux** | `start.sh` (or run `./start.sh` in a terminal) |

A terminal window opens and the app appears in your browser. Each time it
starts, the launcher:

1. **Checks GitHub for updates** and downloads them (`git pull`), if you set the
   app up with `git clone`. You never need to re-download or re-clone.
2. **Installs dependencies** on the first start, and again only when an update
   changed them.
3. Starts the app and opens your browser.

If the update check can't run (you're offline, or you edited one of the app's
files), it says so and starts the version you already have.

- **Keep the terminal window open** while you use the app. It is the app.
- **To stop it**, close that window or press `Ctrl+C` in it.
- **Opened it twice?** No problem. The second launch just reopens the browser
  page for the copy that is already running.

### Make it even quicker

- **Desktop / Dock shortcut**
  - macOS: right-click `Start Local Downloader.command` → **Make Alias**, and
    drag the alias to your Desktop or to the right side of the Dock.
  - Windows: right-click `Start Local Downloader.bat` → **Show more options** →
    **Send to** → **Desktop (create shortcut)**. You can rename the shortcut and
    pin it to Start.
  - Linux: most desktops let you create a launcher that runs `start.sh` with
    "Run in terminal" turned on.
- **Bookmark <http://localhost:3210>.** The bookmark only works while the app
  is running.
- **Keep yt-dlp updated** (see step 2). Websites change often, and updating
  yt-dlp fixes most "Unable to retrieve" errors.

**First double-click on macOS:** if macOS says the file can't be opened because
it is from an unidentified developer, right-click it, choose **Open**, then
**Open** again. It only asks once. If it says you don't have permission, run
`chmod +x "Start Local Downloader.command"` once in Terminal from this folder.

---

## Updating

The launchers update the app automatically each time they start (see
[Everyday use](#everyday-use)). To update by hand, run this in the project
folder:

```bash
git pull
```

- If you downloaded the project as a ZIP instead of using `git clone`,
  automatic updates aren't possible. Clone it once with git to get them.
- Don't edit the app's files if you want automatic updates. A local edit to a
  file that an update also changes blocks the update. `git status` shows what
  you changed, and `git restore <file>` undoes it.
- Your `downloads/` folder is never touched by updates.
- To turn off the update check, set `LOCAL_DOWNLOADER_NO_UPDATE=1`.

---

## Video compatibility

Many sites serve their highest-quality streams as VP9 or AV1 video with Opus
audio. Those play in browsers and VLC, but not in QuickTime ("This file contains
some media which isn't compatible with QuickTime Player"). To avoid that:

- The app **prefers H.264 video with AAC audio** at the highest resolution up
  to the quality you pick. On YouTube that usually means up to 1080p.
- If a site has no H.264 version, the app downloads the best available stream
  and then **converts it to H.264/AAC with ffmpeg**. The progress card shows
  "Converting..." with a percentage. Conversion can take a while for long or
  high-resolution videos.
- Files that are already compatible are left untouched.

**Files downloaded with an older version** may still be VP9/AV1. Download the
same video again at the same quality and the app converts the existing file.

---

## Where files go

Everything is saved to the `downloads/` folder inside this project. Names look
like this:

- Video: `Title (1080p) [videoid].mp4`
- Audio: `Title [videoid].mp3`

If a file with the same name already exists, yt-dlp reuses it instead of
downloading it again. Delete the existing file to download it fresh.

---

## Configuration (optional)

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3210` | Port to listen on (always bound to `127.0.0.1`) |
| `YTDLP_PATH` | `yt-dlp` | Full path to the yt-dlp executable if it is not on `PATH` |
| `FFMPEG_PATH` | `ffmpeg` | Full path to the ffmpeg executable if it is not on `PATH` |
| `LOCAL_DOWNLOADER_NO_UPDATE` | unset | Set to `1` to stop the launchers checking GitHub for updates |

Examples:

```bash
# macOS / Linux
PORT=4000 npm start
YTDLP_PATH=/opt/tools/yt-dlp FFMPEG_PATH=/opt/tools/ffmpeg npm start
```

```powershell
# Windows PowerShell
$env:PORT=4000; npm start
$env:FFMPEG_PATH="C:\ffmpeg\bin\ffmpeg.exe"; npm start
```

yt-dlp runs with `--ignore-config`, so your personal yt-dlp config file is not
used. This keeps the app's behavior predictable.

---

## Troubleshooting

**"yt-dlp was not found. Install yt-dlp and restart the app."**
`yt-dlp --version` must work in the same terminal you run `npm start` from.
Install it (step 2), open a new terminal, and start the app again. If yt-dlp is
installed somewhere unusual, set `YTDLP_PATH` to its full path.

**"ffmpeg was not found. Install ffmpeg for video/audio processing."**
ffmpeg merges separate video and audio streams and converts audio to MP3/M4A,
so downloads stay disabled until it is available. Install it (step 3), make
sure `ffmpeg -version` works, and restart the app, or set `FFMPEG_PATH`.

**"Unable to retrieve this media..."**
- Check that the URL opens in your browser and points to a single video, not
  a playlist or channel page.
- Update yt-dlp (see the note in step 2). Sites change often, and an outdated
  yt-dlp is the most common cause.
- Media that needs a login, is private, members-only, age-gated or
  DRM-protected is not supported.
- The terminal shows yt-dlp's exact error message.

**"The selected quality is not available for this media."**
Pick **Best available**, or a lower quality.

**Port already in use (`EADDRINUSE`)**
Another program is using port 3210. Close it, or start with another port:
`PORT=4000 npm start`, then open `http://localhost:4000`.

**The page does not load at `localhost`**
Try <http://127.0.0.1:3210>. The server only listens on the IPv4 loopback
address, and some systems resolve `localhost` to IPv6 first.

**"Show in folder" / "Open file" does nothing or shows an error**
These use your operating system's file manager (`open` on macOS, Explorer on
Windows, `xdg-open` on Linux). On Linux, install `xdg-utils` if it is missing.
The file is still in `downloads/` either way.

**The download stops in "Processing..." for a long time**
Converting long videos or audio with ffmpeg can take a while, especially for
MP3. Check the terminal. If nothing changes for several minutes, cancel and try
again.

**Non-English characters in file names look wrong (Windows)**
Update yt-dlp to the latest version. The app already asks yt-dlp for UTF-8
output.

---

## How it works

```
local-downloader/
├── package.json      npm scripts and the one dependency (express)
├── server.js         local HTTP server + yt-dlp process management
├── Start Local Downloader.command   double-click launcher (macOS)
├── Start Local Downloader.bat       double-click launcher (Windows)
├── start.sh          launcher (Linux)
├── launch.js         used by the launchers: update, install, start
├── downloads/        finished files (temporary files go in downloads/.tmp)
├── public/
│   ├── index.html    markup
│   ├── style.css     styles
│   └── app.js        UI logic (vanilla JS)
└── README.md
```

### API (localhost only)

| Method & path | Purpose |
| --- | --- |
| `GET /api/status` | Whether yt-dlp and ffmpeg are installed, and their versions |
| `POST /api/analyze` `{ "url" }` | Runs `yt-dlp --dump-single-json` and returns title, uploader, duration, thumbnail and resolutions |
| `GET /api/thumbnail/:id` | Thumbnail for an analyzed item, fetched by the server so the page only talks to localhost |
| `POST /api/download` `{ "url", "mode": "video"\|"audio", "quality": "best"\|"1080"\|"720"\|"480"\|"360", "audioFormat": "mp3"\|"m4a" }` | Starts a download and returns a job |
| `GET /api/download/:id` | Current job state |
| `GET /api/download/:id/events` | Live progress (Server-Sent Events) |
| `POST /api/download/:id/cancel` | Cancel a running download |
| `POST /api/download/:id/reveal` | Show the finished file in the file manager |
| `POST /api/download/:id/open` | Open the finished file with the default app |
| `POST /api/open-downloads` | Open the downloads folder |

### Safety measures

- The server listens on `127.0.0.1` only. Requests with any other `Host`
  header are rejected (protects against DNS rebinding), and POST requests from
  other websites are rejected via `Origin` / `Sec-Fetch-Site` checks.
- yt-dlp is started with `child_process.spawn` and an argument array. No
  shell is involved, and the URL is always passed after `--`, so it can never
  be read as an option.
- URLs must be `http`/`https`, at most 2048 characters, without whitespace or
  embedded credentials. Every option value is checked against a fixed allowlist.
- File names are sanitized by yt-dlp (`--windows-filenames`, title truncated)
  and checked again by the server. Finished files must be regular files
  directly inside `downloads/`.
- The frontend never sees or sends file system paths. Open/reveal actions
  refer to a download job id, and the server looks up the path itself.
- A strict Content-Security-Policy limits the page to resources from the
  local server.
- No upload or remote-access features.
