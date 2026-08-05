import { chromium } from 'playwright';
const SID = '84dbda20-1e47-41b8-8bbb-d083092fec7d';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
let newTabs = 0;
ctx.on('page', () => { newTabs++; });
await page.addInitScript((sid) => {
  sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
}, SID);
await page.goto('http://localhost:3456/');
await page.waitForLoadState('networkidle');
await page.waitForTimeout(3500);
const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`);
const bar = panel.locator('.session-notes');
const row = bar.locator('.session-notes-toggle');
const box = await row.boundingBox();

// Sweep the row: click each spot, record whether editor opened, whether a tab opened
for (const frac of [0.05, 0.12, 0.2, 0.35, 0.6, 0.9]) {
  const x = box.x + box.width * frac, y = box.y + box.height/2;
  const target = await page.evaluate(([x,y]) => {
    const el = document.elementFromPoint(x,y);
    return el ? el.tagName + '.' + (el.className?.toString?.().slice(0,40)||'') : 'NONE';
  }, [x,y]);
  const before = newTabs;
  await page.mouse.click(x, y);
  await page.waitForTimeout(900);
  const opened = await bar.locator('.session-notes-textarea').count();
  console.log(`x@${(frac*100).toFixed(0)}% [${target}] -> editorOpen=${opened} newTab=${newTabs>before} url=${page.url().slice(0,45)}`);
  if (opened) { // close it again for the next probe
    await page.keyboard.press('Escape');
    await panel.locator('.session-panel-body').click({ position: {x:5,y:5} }).catch(()=>{});
    await page.waitForTimeout(600);
  }
}
console.log('total new tabs:', newTabs);
await b.close();
