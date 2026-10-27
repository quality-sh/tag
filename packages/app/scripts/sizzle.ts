// Records the README's sizzle GIF: the real dashboard over the fake acme GitHub in
// sizzle-scenario.ts, toured in chromium. The page is framed as hyperstition's demo
// video frames its terminal: a serif caption over a dark window. Chromium's screencast
// takes the frames, then ffmpeg encodes them with a palette pass.
// Usage: bun run sizzle [out.gif]   (docs/sizzle.gif by default)
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option, Redacted } from "effect";
import { chromium, type Frame, type Page } from "playwright";
import type { GithubConfig } from "../src/server/config.ts";
import { buildWeb, fakeGithub, serveApp, webRoot } from "../test/helpers.ts";
import { scenario } from "./sizzle-scenario.ts";

const OUT = process.argv[2] ?? new URL("../../../docs/sizzle.gif", import.meta.url).pathname;
const WIDTH = 1200;
const HEIGHT = 675;
/** The app renders wider than the window and is scaled down, so a page shows more of itself. */
const APP_SCALE = 0.9;
const FPS = 15;
const FADE_MS = 300;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const github: GithubConfig = {
  auth: {
    _tag: "app",
    appId: "12345",
    privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString()),
    installationId: Option.some("555"),
  },
  apiUrl: "https://api.github.test",
  slug: Option.some("tag-app"),
  repos: [],
};

const font = async (prefix: string) => {
  const file = (await readdir(join(webRoot, "assets"))).find(
    (f) => f.startsWith(prefix) && f.endsWith(".woff2"),
  );
  if (!file) throw new Error(`no ${prefix} font in ${webRoot}; build the web first`);
  return `/assets/${file}`;
};

/** The frame around the app: a caption, then a window with a title bar and the app in it. */
const stage = async () => `<!doctype html>
<style>
  @font-face { font-family: Cormorant; src: url(${await font("cormorant-garamond-latin-400-normal")}); }
  @font-face { font-family: Fragment; src: url(${await font("fragment-mono-latin-400-normal")}); }
  html, body { margin: 0; background: #000; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  #caption { height: 58px; display: flex; align-items: center; justify-content: center;
    font: 400 25px Cormorant, serif; color: #e0def4; transition: opacity ${FADE_MS}ms; }
  #window { position: absolute; left: 22px; right: 22px; top: 58px; bottom: 20px;
    background: #0c0b10; border: 1px solid #1d1b24; border-radius: 6px; overflow: hidden;
    transition: opacity ${FADE_MS}ms; }
  #bar { height: 24px; display: flex; align-items: center; padding: 0 10px; gap: 6px;
    background: #16141c; position: relative; }
  #bar i { width: 8px; height: 8px; border-radius: 50%; background: #3a3644; }
  #title { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font: 10px Fragment, monospace; color: #908caa; letter-spacing: 0.04em; }
  iframe { border: 0; transform-origin: 0 0; transform: scale(${APP_SCALE});
    width: calc((100%) / ${APP_SCALE}); height: calc((100% - 24px) / ${APP_SCALE}); }
  .out { opacity: 0; }
</style>
<div id="caption" class="out"></div>
<div id="window" class="out">
  <div id="bar"><i></i><i></i><i></i><div id="title"></div></div>
  <iframe src="/#/" title="TAG"></iframe>
</div>`;

type Shot = { readonly data: Buffer; readonly at: number };
type Recording = { readonly shots: ReadonlyArray<Shot>; readonly end: number };

/** Chromium's screencast: a frame each time the page paints, with its time. */
const screencast = async (page: Page) => {
  const shots: Array<Shot> = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (frame) => {
    shots.push({ data: Buffer.from(frame.data, "base64"), at: frame.metadata.timestamp ?? 0 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: WIDTH * 2,
    maxHeight: HEIGHT * 2,
  });
  return async (): Promise<Recording> => {
    await cdp.send("Page.stopScreencast");
    return { shots, end: Date.now() / 1000 };
  };
};

const pause = (ms: number) => Bun.sleep(ms);

/** Fade the caption and the window out or in. */
const fade = async (page: Page, visible: boolean) => {
  await page.evaluate((on) => {
    for (const id of ["caption", "window"])
      document.getElementById(id)?.classList.toggle("out", !on);
  }, visible);
  await pause(FADE_MS);
};

/** The four scenes; recording starts as the first fades in and ends when the last fades out. */
const tour = async (page: Page, app: Frame) => {
  let stop: (() => Promise<Recording>) | undefined;
  const scene = async (caption: string, title: string, go: () => Promise<void>) => {
    if (stop) await fade(page, false);
    await go();
    await page.evaluate(
      ([c, t]) => {
        const caption = document.getElementById("caption");
        const bar = document.getElementById("title");
        if (caption) caption.textContent = c ?? "";
        if (bar) bar.textContent = t ?? "";
      },
      [caption, title],
    );
    stop ??= await screencast(page);
    await fade(page, true);
  };
  const hash = (h: string) => app.evaluate((to) => (location.hash = to), h);
  // Scrolls the app's own window only: scrollIntoView would scroll the stage around it too.
  const glide = async (text: string, at: number) => {
    await app
      .getByText(text, { exact: false })
      .first()
      .evaluate((el, f) => {
        const top = el.getBoundingClientRect().top + scrollY - innerHeight * f;
        scrollTo({ top, behavior: "smooth" });
      }, at);
    await pause(900);
  };

  await scene("Every repository's tests, in one place.", "tag · overview", async () => {
    await hash("#/");
    await app.getByText("acme/sprockets").first().waitFor();
  });
  await pause(1300);
  await glide("acme/gizmos", 0.15);
  await pause(600);

  await scene(
    "A repository: its runs, its pull request, its release.",
    "tag · acme/widgets",
    async () => {
      await hash("#/r/acme/widgets");
      await app.getByText("#42").first().waitFor();
    },
  );
  await pause(1000);
  await app.evaluate(() => scrollBy({ top: 240, behavior: "smooth" }));
  await pause(1200);

  await scene("A failing test, with its error.", "tag · report", async () => {
    await app.locator('a[href^="#/report/"]').first().click();
    await app.getByText("applies a discount code").first().waitFor();
  });
  await pause(700);
  await glide("applies a discount code", 0.3);
  await pause(1200);

  await scene(
    "A repository without reports gets a CI change.",
    "tag · add repositories",
    async () => {
      await hash("#/onboarding");
      await app.getByRole("button", { name: "Propose pull request", exact: true }).waitFor();
    },
  );
  await pause(700);
  await app.getByRole("button", { name: "Propose pull request", exact: true }).click();
  await glide("Save the Vitest report", 0.4);
  await pause(1500);
  await fade(page, false);
  if (!stop) throw new Error("the tour recorded nothing");
  return stop();
};

/** Constant-rate frames from the screencast's uneven ones, encoded with one palette. */
const encode = async (shots: ReadonlyArray<Shot>, end: number) => {
  const dir = await mkdtemp(join(tmpdir(), "tag-sizzle-"));
  try {
    const lines: Array<string> = [];
    for (const [i, shot] of shots.entries()) {
      const file = join(dir, `${String(i).padStart(5, "0")}.png`);
      await writeFile(file, shot.data);
      const next = shots[i + 1]?.at ?? end;
      lines.push(`file '${file}'`, `duration ${Math.max(0.001, next - shot.at).toFixed(3)}`);
    }
    // The concat demuxer takes the last file's duration only when it is listed twice.
    lines.push(lines[lines.length - 2] ?? "");
    await writeFile(join(dir, "list.txt"), `${lines.join("\n")}\n`);
    const filters =
      `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];` +
      "[a]palettegen=max_colors=128:stats_mode=diff[p];" +
      "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
    const list = join(dir, "list.txt");
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vf",
        filters,
        OUT,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await ffmpeg.exited) !== 0) throw new Error("ffmpeg failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const main = async () => {
  await buildWeb();
  const app = await serveApp({
    webRoot,
    http: fakeGithub(scenario()).layer,
    overrides: { github: Option.some(github), password: Redacted.make("") },
  });
  const browser = await chromium.launch();
  try {
    const { passId } = (await (
      await fetch(`${app.base}/api/ingest`, { method: "POST", body: "{}" })
    ).json()) as { passId: string };
    for (let done = false; !done; await pause(50)) {
      const status = (await (await fetch(`${app.base}/api/ingest/status`)).json()) as {
        lastFinished: { passId: string } | null;
      };
      done = status.lastFinished?.passId === passId;
    }
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    page.setDefaultTimeout(10_000);
    const html = await stage();
    await page.route(`${app.base}/sizzle`, (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto(`${app.base}/sizzle`);
    const frame = page.frame({ url: /#\// });
    if (!frame) throw new Error("the app frame did not load");
    const { shots, end } = await tour(page, frame);
    await encode(shots, end);
    console.log(`${OUT}: ${shots.length} frames`);
  } finally {
    await browser.close();
    await app.stop();
  }
};

await main();
