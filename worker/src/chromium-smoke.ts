import puppeteer from 'puppeteer-core';

// Proves the container can launch headless Chromium and render a page (G-T1-2 verify /
// AC: worker runtime is headless-render capable — unblocks Adapter F / T8).
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium';

export async function chromiumSmoke(): Promise<{ ok: boolean; title: string }> {
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>kids-fun-smoke</title><h1>ok</h1>');
    const title = await page.title();
    return { ok: title === 'kids-fun-smoke', title };
  } finally {
    await browser.close();
  }
}

// Allow `npm run smoke` to run it standalone (used in the Docker build/verify).
if (require.main === module) {
  chromiumSmoke()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`chromium smoke: ${r.ok ? 'PASS' : 'FAIL'} (title="${r.title}")`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('chromium smoke error:', err);
      process.exit(1);
    });
}
