/**
 * Measure the live DeepChat panel: boot time over fresh contexts, eight
 * interactions at ten repetitions each, the model catalog, the effort ladder,
 * and the console/page errors seen along the way.
 *
 * Usage: node paper/collect-ui.mjs
 * Output: paper/data/ui-raw.json
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = 'http://127.0.0.1:53254/';
const WORKSPACE = process.env.WORKSPACE || process.cwd();
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIGURES = `${WORKSPACE}/paper/figures`;
const DATA = `${WORKSPACE}/paper/data`;
mkdirSync(FIGURES, { recursive: true });
mkdirSync(DATA, { recursive: true });

const cookie = JSON.parse(execFileSync('python3', ['-c', String.raw`
import sqlite3,os,base64,json
db=os.path.expanduser('~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies')
con=sqlite3.connect('file:'+db+'?mode=ro',uri=True)
for name,value in con.execute("select name,value from cookies where host_key='127.0.0.1' and length(value)>0"):
    parts=value.split('.'); payload=parts[1]; payload+='='*(-len(payload)%4)
    authority=json.loads(base64.urlsafe_b64decode(payload)).get('authority')
    if authority=='127.0.0.1:53254':
        print(json.dumps({'name':name,'value':value}))
        break
`], { encoding: 'utf8' }).trim());

const VIEWPORT = { width: 1280, height: 860 };
const browser = await chromium.launch({
	executablePath: CHROME,
	headless: true,
	args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
});

/** Every console/page error and failed request, counted once per message. */
const errorCounts = new Map();
function watch(page, where) {
	page.on('pageerror', (error) => {
		const key = `PAGEERROR [${where}] ${error?.message ?? error}`;
		errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
	});
	page.on('console', (message) => {
		if (message.type() !== 'error') return;
		const key = `CONSOLE [${where}] ${message.text().slice(0, 600)}`;
		errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
	});
	page.on('requestfailed', (request) => {
		const key = `REQFAIL [${where}] ${request.url().slice(0, 200)} ${request.failure()?.errorText ?? ''}`;
		errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
	});
}

async function enterDeepChat(page) {
	await page.waitForSelector('[data-slot="sidebar"]', { timeout: 30000 });
	const present = await page.evaluate(() => Boolean(document.querySelector('[data-chat-mode]')));
	if (present) return false;
	const clicked = await page.evaluate(() => {
		const sidebar = document.querySelector('[data-slot="sidebar"]');
		const entry = [...sidebar.querySelectorAll('button, [role="button"]')]
			.find((el) => (el.textContent || '').trim() === 'DeepChat');
		entry?.click();
		return Boolean(entry);
	});
	if (!clicked) throw new Error('DeepChat sidebar entry not found');
	return true;
}

/**
 * Click an element and resolve the page-side time at which the requested DOM
 * change is first visible, polling with requestAnimationFrame (one frame
 * resolution). The click happens in-page so no protocol round-trip is counted.
 */
async function measure(page, spec) {
	return page.evaluate((spec) => {
		const visible = (el) => {
			if (!el) return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const current = () => document.querySelector(spec.target);
		const el = document.querySelector(spec.click);
		if (!el) return { error: `missing ${spec.click}` };
		const before = spec.kind === 'attrFlip'
			? el.getAttribute(spec.attr)
			: spec.kind === 'textChange'
				? (current()?.textContent ?? '').trim()
				: null;
		if (spec.kind === 'textChange' && spec.expect !== undefined && before === spec.expect) {
			return { error: `already ${spec.expect}` };
		}
		const t0 = performance.now();
		el.click();
		return new Promise((resolve) => {
			const check = () => {
				let ok = false;
				let after = null;
				if (spec.kind === 'visible') {
					ok = visible(current());
					after = ok;
				} else if (spec.kind === 'attrFlip') {
					after = el.getAttribute(spec.attr);
					ok = after !== before;
				} else if (spec.kind === 'textChange') {
					after = (current()?.textContent ?? '').trim();
					ok = after !== before && (spec.expect === undefined || after === spec.expect);
				}
				if (ok) {
					resolve({ ms: performance.now() - t0, before, after });
					return;
				}
				if (performance.now() - t0 > 3000) {
					resolve({ error: 'timeout', before });
					return;
				}
				requestAnimationFrame(check);
			};
			requestAnimationFrame(check);
		});
	}, spec);
}

async function closeOverlays(page) {
	for (const selector of ['.cm_effortCard', '.cm_brandMenu', '.cm_workspaceCard', '.cm_accountCard']) {
		if ((await page.locator(selector).count()) === 0) continue;
		await page.keyboard.press('Escape');
		await page.waitForTimeout(100);
		if ((await page.locator(selector).count()) === 0) continue;
		await page.mouse.click(640, 120);
		await page.waitForTimeout(100);
		if ((await page.locator(selector).count()) > 0) throw new Error(`could not close ${selector}`);
	}
}

function pushSample(bucket, result, label) {
	if (result?.error) {
		bucket.errors.push({ label, error: result.error });
		return;
	}
	bucket.samples.push(result.ms);
	if (result.before !== null && result.after !== null) bucket.transitions.push({ before: result.before, after: result.after });
}

//#region boot
const boot = [];
const bootDetail = [];
for (let round = 0; round < 5; round += 1) {
	const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
	await context.addCookies([{ name: cookie.name, value: cookie.value, url: URL }]);
	const page = await context.newPage();
	watch(page, `boot-${round + 1}`);
	const started = Date.now();
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await enterDeepChat(page);
	await page.waitForSelector('[data-chat-mode]', { timeout: 30000 });
	const toPanel = Date.now() - started;
	await page.waitForTimeout(500);
	const total = Date.now() - started;
	boot.push(total);
	bootDetail.push({ round: round + 1, toPanelMs: toPanel, bootMs: total });
	await context.close();
}
//#endregion

//#region interaction page
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await context.addCookies([{ name: cookie.name, value: cookie.value, url: URL }]);
const page = await context.newPage();
watch(page, 'interaction');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await enterDeepChat(page);
await page.waitForSelector('[data-chat-mode]', { timeout: 30000 });
await page.waitForTimeout(1200);
await closeOverlays(page);
await page.evaluate(() => document.querySelector('.cm_newChatBtn')?.click());
await page.waitForTimeout(400);

const results = {
	'new_chat_hero': { samples: [], transitions: [], errors: [] },
	'effort_open': { samples: [], transitions: [], errors: [] },
	'effort_bolt': { samples: [], transitions: [], errors: [] },
	'effort_model_menu': { samples: [], transitions: [], errors: [] },
	'pill_pressed': { samples: [], transitions: [], errors: [] },
	'workspace_card': { samples: [], transitions: [], errors: [] },
	'account_card': { samples: [], transitions: [], errors: [] },
	'slider_drag_max': { samples: [], transitions: [], errors: [] },
};

//#region model catalog
const brandOpened = await page.evaluate(() => {
	const button = document.querySelector('.cm_brandBtn');
	button?.click();
	return Boolean(button);
});
await page.waitForSelector('.cm_brandMenu', { timeout: 3000 });
const catalog = await page.evaluate(() => {
	const menu = document.querySelector('.cm_brandMenu');
	const groups = [];
	let current = null;
	for (const child of menu.children) {
		if (child.classList.contains('cm_menuGroup')) {
			current = { group: child.textContent.trim(), items: [] };
			groups.push(current);
		} else if (child.classList.contains('cm_menuItem')) {
			const item = {
				label: child.querySelector('.cm_menuLabel')?.textContent?.trim() ?? '',
				description: child.querySelector('.cm_menuDesc')?.textContent?.trim() ?? '',
				checked: child.getAttribute('aria-checked') === 'true',
			};
			if (current === null) {
				current = { group: null, items: [] };
				groups.push(current);
			}
			current.items.push(item);
		}
	}
	return {
		groups,
		currentLabel: document.querySelector('.cm_brandModel')?.textContent?.trim() ?? null,
		menuText: menu.innerText,
	};
});
await closeOverlays(page);
//#endregion

//#region effort ladder
await page.evaluate(() => document.querySelector('.cm_effortBtn')?.click());
await page.waitForSelector('.cm_effortCard', { timeout: 3000 });
const effortState = await page.evaluate(() => {
	const slider = document.querySelector('.cm_gradientSlider');
	return {
		current: document.querySelector('.cm_effortName')?.textContent?.trim() ?? null,
		boltPressed: document.querySelector('.cm_effortBolt')?.getAttribute('aria-pressed') ?? null,
		min: slider ? Number(slider.min) : null,
		max: slider ? Number(slider.max) : null,
		value: slider ? Number(slider.value) : null,
		disabled: slider ? slider.disabled : null,
		modelName: document.querySelector('.cm_effortModelBtn')?.innerText?.trim() ?? null,
	};
});
await page.waitForTimeout(100);
// Walk every stop by driving the real range input, to report the ladder itself.
const ladder = await page.evaluate(async () => {
	const slider = document.querySelector('.cm_gradientSlider');
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
	const out = [];
	const max = Number(slider.max);
	for (let index = 0; index <= max; index += 1) {
		setter.call(slider, String(index));
		slider.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 90));
		out.push({ index, label: document.querySelector('.cm_effortName')?.textContent?.trim() ?? null });
	}
	return out;
});
await page.evaluate(() => document.querySelector('.cm_effortReset')?.click());
await page.waitForTimeout(150);
await closeOverlays(page);
//#endregion

//#region interactions
const ROUNDS = 10;
for (let round = 0; round < ROUNDS; round += 1) {
	// 1. new chat in a thread -> landing hero
	await closeOverlays(page);
	await page.evaluate(() => document.querySelector('.cm_chatOpen')?.click());
	await page.waitForFunction(() => !document.querySelector('.cm_heroTitle'), null, { timeout: 5000 });
	await page.waitForTimeout(120);
	pushSample(results.new_chat_hero, await measure(page, { click: '.cm_newChatBtn', target: '.cm_heroTitle', kind: 'visible' }), `round ${round + 1}`);
	await page.waitForTimeout(120);

	// 2. effort button -> effort card, then close
	await closeOverlays(page);
	pushSample(results.effort_open, await measure(page, { click: '.cm_effortBtn', target: '.cm_effortCard', kind: 'visible' }), `round ${round + 1}`);
	await page.waitForTimeout(80);
	await closeOverlays(page);

	// 3. bolt -> effort name changes to Max (popover open, reset first)
	await page.evaluate(() => document.querySelector('.cm_effortBtn')?.click());
	await page.waitForSelector('.cm_effortCard', { timeout: 3000 });
	await page.evaluate(() => document.querySelector('.cm_effortReset')?.click());
	await page.waitForTimeout(120);
	pushSample(results.effort_bolt, await measure(page, { click: '.cm_effortBolt', target: '.cm_effortName', kind: 'textChange', expect: 'Max' }), `round ${round + 1}`);
	await page.waitForTimeout(80);
	await closeOverlays(page);

	// 4. effort model button -> brand menu (effort open first)
	await page.evaluate(() => document.querySelector('.cm_effortBtn')?.click());
	await page.waitForSelector('.cm_effortCard', { timeout: 3000 });
	pushSample(results.effort_model_menu, await measure(page, { click: '.cm_effortModelBtn', target: '.cm_brandMenu', kind: 'visible' }), `round ${round + 1}`);
	await page.waitForTimeout(80);
	await closeOverlays(page);

	// 5. memory pill -> aria-pressed flips
	await closeOverlays(page);
	pushSample(results.pill_pressed, await measure(page, { click: '.cm_pillAction', target: '.cm_pillAction', kind: 'attrFlip', attr: 'aria-pressed' }), `round ${round + 1}`);
	await page.waitForTimeout(80);

	// 6. workspace chip -> workspace card, then close
	await closeOverlays(page);
	pushSample(results.workspace_card, await measure(page, { click: '.cm_contextChipButton', target: '.cm_workspaceCard', kind: 'visible' }), `round ${round + 1}`);
	await page.waitForTimeout(80);
	await closeOverlays(page);

	// 7. account button -> account card, then close
	await closeOverlays(page);
	pushSample(results.account_card, await measure(page, { click: '.cm_accountBtn', target: '.cm_accountCard', kind: 'visible' }), `round ${round + 1}`);
	await page.waitForTimeout(80);
	await closeOverlays(page);

	// 8. mouse drag the gradient slider to the last stop -> name becomes Max
	await page.evaluate(() => document.querySelector('.cm_effortBtn')?.click());
	await page.waitForSelector('.cm_effortCard', { timeout: 3000 });
	await page.evaluate(() => document.querySelector('.cm_effortReset')?.click());
	await page.waitForTimeout(150);
	const dragStart = await page.evaluate(() => {
		window.__drag = { start: 0, end: 0, initial: document.querySelector('.cm_effortName')?.textContent?.trim() ?? null };
		const input = document.querySelector('.cm_gradientSlider');
		if (!input) return null;
		input.addEventListener('mousedown', () => { window.__drag.start = performance.now(); }, { capture: true });
		const poll = () => {
			const label = document.querySelector('.cm_effortName')?.textContent?.trim();
			if (window.__drag.start !== 0 && label === 'Max') {
				window.__drag.end = performance.now();
				return;
			}
			requestAnimationFrame(poll);
		};
		requestAnimationFrame(poll);
		return { min: Number(input.min), max: Number(input.max), value: Number(input.value) };
	});
	if (dragStart === null) {
		results.slider_drag_max.errors.push({ label: `round ${round + 1}`, error: 'no slider' });
	} else {
		const box = await page.locator('.cm_gradientSlider').boundingBox();
		const fraction = dragStart.max === 0 ? 0 : dragStart.value / dragStart.max;
		const startX = box.x + 13 + fraction * (box.width - 26);
		const endX = box.x + box.width - 13;
		const y = box.y + box.height / 2;
		await page.mouse.move(startX, y);
		await page.mouse.down();
		for (let step = 1; step <= 12; step += 1) {
			await page.mouse.move(startX + ((endX - startX) * step) / 12, y);
			await page.waitForTimeout(8);
		}
		await page.mouse.up();
		await page.waitForTimeout(150);
		const drag = await page.evaluate(() => window.__drag);
		if (drag.end === 0) {
			results.slider_drag_max.errors.push({ label: `round ${round + 1}`, error: `label stayed ${drag.initial}` });
		} else {
			results.slider_drag_max.samples.push(drag.end - drag.start);
			results.slider_drag_max.transitions.push({ before: drag.initial, after: 'Max' });
		}
	}
	await page.waitForTimeout(120);
	await closeOverlays(page);
}
//#endregion

//#region screenshots
await page.evaluate(() => {
	const slot = document.querySelector('[data-slot="sidebar"]');
	const column = slot ? slot.parentElement : null;
	if (!column) return;
	column.style.width = '0px';
	column.style.minWidth = '0px';
	column.style.maxWidth = '0px';
	column.style.overflow = 'hidden';
	column.style.padding = '0';
	column.style.border = '0';
	const frame = column.parentElement;
	if (frame && getComputedStyle(frame).display === 'grid') {
		frame.style.gridTemplateColumns = '0px minmax(0, 1fr) 0px';
		const handle = frame.querySelector(':scope > [class*="handle"]');
		if (handle) handle.style.display = 'none';
	}
});
await page.evaluate(() => document.querySelector('.cm_newChatBtn')?.click());
await page.waitForTimeout(600);
const screenshots = {};
screenshots.landing = `${FIGURES}/ui-landing.png`;
await page.screenshot({ path: screenshots.landing });

await page.evaluate(() => document.querySelector('.cm_effortBtn')?.click());
await page.waitForTimeout(600);
screenshots.effort = `${FIGURES}/ui-effort.png`;
await page.screenshot({ path: screenshots.effort });
await closeOverlays(page);

await page.evaluate(() => document.querySelector('.cm_brandBtn')?.click());
await page.waitForTimeout(500);
screenshots.model = `${FIGURES}/ui-model.png`;
await page.screenshot({ path: screenshots.model });
await closeOverlays(page);
//#endregion

const errors = [...errorCounts.entries()].map(([message, count]) => ({ message, count }));
writeFileSync(`${DATA}/ui-raw.json`, JSON.stringify({
	generatedAt: new Date().toISOString(),
	url: URL,
	viewport: VIEWPORT,
	deviceScaleFactor: 1,
	boot,
	bootDetail,
	catalog,
	efforts: { ...effortState, ladder },
	results,
	screenshots,
	errors,
}, null, 2));

console.log(JSON.stringify({
	boot,
	bootDetail,
	catalogGroups: catalog.groups.map((group) => ({ group: group.group, items: group.items.map((item) => item.label) })),
	efforts: { current: effortState.current, min: effortState.min, max: effortState.max, ladder },
	samples: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.samples])),
	errors: results,
	errorCount: errors.length,
}, null, 1));

await browser.close();
