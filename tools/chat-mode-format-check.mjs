/**
 * Offline checks for the Chat panel's answer rendering and file decoding.
 *
 * These drive the shipped bundle's own helpers: LaTeX to MathML, Markdown block
 * structure, the byte-level decoder used for uploads, and one end-to-end upload
 * of a GBK-encoded Mathematica notebook.
 *
 * Usage: node tools/chat-mode-format-check.mjs
 */
import { loadClient } from './chat-mode-load.mjs';

const failures = [];
/** Record one expectation. */
function check(condition, label, detail) {
	if (condition) {
		console.log(`  ok  ${label}`);
		return;
	}
	failures.push(label);
	console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const { module, reactStub } = loadClient();
const { internal } = module;
const { React } = reactStub;

/** Flatten a React element tree into tag names, text, and injected markup. */
function flatten(node, out = { tags: [], text: [], html: [] }) {
	if (node === null || node === undefined || node === false || node === true) return out;
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node === 'string' || typeof node === 'number') {
		out.text.push(String(node));
		return out;
	}
	if (typeof node.type === 'function') {
		reactStub.reset();
		flatten(node.type(node.props), out);
		return out;
	}
	if (typeof node.type === 'symbol') {
		for (const child of node.children ?? []) flatten(child, out);
		return out;
	}
	out.tags.push(node.type);
	if (node.props?.dangerouslySetInnerHTML?.__html !== undefined) out.html.push(node.props.dangerouslySetInnerHTML.__html);
	for (const child of node.children ?? []) flatten(child, out);
	return out;
}

/** Render Markdown through the shipped renderer. */
function render(text) {
	return flatten(internal.renderRich(text));
}

//#region latex
const math = (tex, display = false) => internal.texToMathML(tex, display);

check(/<math[^>]*display="inline"/.test(math('x')), 'inline math carries the inline display mode');
check(/<math[^>]*display="block"/.test(math('x', true)), 'display math carries the block display mode');

const fraction = math('\\frac{a}{b}');
check(fraction.includes('<mfrac>') && fraction.includes('<mi>a</mi>') && fraction.includes('<mi>b</mi>'), 'a fraction becomes mfrac', fraction);

const power = math('x^2');
check(power.includes('<msup>') && power.includes('<mi>x</mi>') && power.includes('<mn>2</mn>'), 'a superscript becomes msup', power);

const both = math('x_i^2');
check(both.includes('<msubsup>') && both.indexOf('<msubsup>') < both.indexOf('<mn>2</mn>'), 'a subscript and superscript become msubsup', both);

const sum = math('\\sum_{i=1}^{n} i');
check(sum.includes('largeop="true"') && sum.includes('∑') && sum.includes('<msubsup>'), 'a sum keeps its limits and draws the operator', sum);

const integral = math('\\int_0^\\infty e^{-x} dx');
check(integral.includes('∫') && integral.includes('∞') && integral.includes('<msup>'), 'an integral with an infinity limit renders', integral);

check(math('\\sqrt{x}').includes('<msqrt>'), 'a square root becomes msqrt');
check(math('\\sqrt[3]{x}').includes('<mroot>'), 'an indexed root becomes mroot');

const letters = math('\\alpha \\times \\beta \\le \\gamma');
check(letters.includes('α') && letters.includes('×') && letters.includes('≤') && letters.includes('γ'), 'greek letters and relations map to glyphs', letters);

const delimiters = math('\\left( \\frac{1}{2} \\right)');
check(delimiters.includes('stretchy="true"') && delimiters.includes('<mfrac>'), 'left/right delimiters stretch around their content', delimiters);

const matrix = math('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', true);
check((matrix.match(/<mtr>/g) ?? []).length === 2 && (matrix.match(/<mtd>/g) ?? []).length === 4, 'a matrix becomes a two-row table', matrix);
check(matrix.includes('<mo>(</mo>') && matrix.includes('<mo>)</mo>'), 'a pmatrix is wrapped in parentheses', matrix);

const cases = math('\\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}', true);
check(cases.includes('<mtable>') && cases.includes('{'), 'a cases block becomes a braced table');

check(math('\\text{hello world}').includes('<mtext>hello world</mtext>'), 'text mode stays upright text');
check(math('\\mathbb{R}').includes('ℝ'), 'blackboard bold maps to its Unicode letter', math('\\mathbb{R}'));
check(math('\\mathcal{L}').includes('ℒ'), 'calligraphic maps to its Unicode letter', math('\\mathcal{L}'));
check(math('\\lim_{x \\to 0}').includes('movablelimits="true"'), 'a limit operator places its script underneath');
check(math('\\hat{x}').includes('<mover') && math('\\vec{v}').includes('→'), 'accents are drawn over their argument');
check(math('\\sin x').includes('<mi>sin</mi>'), 'a named function stays upright');
check(math('a \\quad b').includes('<mspace width="1em">'), 'spacing commands keep their width');
check(math('\\foo').includes('<mi>foo</mi>'), 'an unknown command shows its name, not its backslash', math('\\foo'));
check(math('a < b & c').includes('&lt;') && !math('a < b & c').includes('<b>'), 'math output escapes angle brackets and ampersands');
check(math('').includes('<mrow></mrow>'), 'an empty expression still produces valid MathML');
check(internal.texToMathML('\\frac{1}', false).includes('<mfrac>'), 'an unterminated fraction still renders partially');

/* A battery of expressions a physics or maths answer actually contains. */
const battery = [
	'E = mc^2',
	'\\frac{\\partial f}{\\partial x}',
	'\\vec{F} = m\\vec{a}',
	'\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
	'\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
	'\\begin{aligned} a &= b + c \\\\ d &= e - f \\end{aligned}',
	'\\left[ \\begin{matrix} 1 & 0 \\\\ 0 & 1 \\end{matrix} \\right]',
	'\\begin{cases} x^2 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
	'{}^{238}_{92}\\mathrm{U}',
	'\\nabla \\times \\vec{B} = \\mu_0 \\vec{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\vec{E}}{\\partial t}',
	'\\hat{H}\\psi = E\\psi',
	'\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e',
	'\\mathbb{E}[X] = \\int x \\, dP',
	'\\theta \\in [0, 2\\pi)',
	'\\mathcal{O}(n \\log n)',
	'\\begin{bmatrix} a_{11} & \\cdots & a_{1n} \\\\ \\vdots & \\ddots & \\vdots \\\\ a_{n1} & \\cdots & a_{nn} \\end{bmatrix}',
];
const leaked = [];
const broken = [];
for (const expression of battery) {
	const markup = internal.texToMathML(expression, true);
	if (!markup.startsWith('<math') || !markup.includes('</math>')) broken.push(expression);
	if (/\\/.test(markup)) leaked.push(expression);
}
check(broken.length === 0, 'every expression in the battery produces well-formed MathML', broken.join(' | '));
check(leaked.length === 0, 'no LaTeX backslash leaks into the rendered math', leaked.join(' | '));
check(battery.every((expression) => {
	const markup = internal.texToMathML(expression, true);
	return markup.includes('<mfrac>') || markup.includes('<msub') || markup.includes('<msup') || markup.includes('<mtable>') || markup.includes('<mi>');
}), 'the battery exercises fractions, scripts, and tables');
//#endregion

//#region markdown
const document = [
	'# Title',
	'',
	'Some **bold** and *italic* and `code` and a [link](https://example.com).',
	'',
	'- first',
	'- second',
	'',
	'1. one',
	'2. two',
	'',
	'> quoted text',
	'',
	'| a | b |',
	'| --- | --- |',
	'| 1 | 2 |',
	'',
	'```python',
	'print(1)',
	'```',
	'',
	'$$',
	'\\frac{a}{b}',
	'$$',
	'',
	'Inline $x^2$ math.',
	'',
	'---',
].join('\n');
const rendered = render(document);
const tags = new Set(rendered.tags);
const text = rendered.text.join('\n');
check(tags.has('h1'), 'a heading becomes an h1');
check(tags.has('strong') && tags.has('em') && tags.has('code'), 'bold, italic, and inline code are marked up');
check(tags.has('a') && rendered.tags.includes('a'), 'a link becomes an anchor');
check(tags.has('ul') && tags.has('ol') && text.includes('second') && text.includes('two'), 'bullet and numbered lists render');
check(tags.has('blockquote') && text.includes('quoted text'), 'a block quote renders');
check(tags.has('table') && tags.has('th') && tags.has('td') && text.includes('1'), 'a pipe table renders with a header row');
check(tags.has('pre') && text.includes('print(1)'), 'a fenced block renders as code');
check(rendered.html.some((markup) => markup.includes('<mfrac>')), 'display math becomes MathML', rendered.html.length);
check(rendered.html.some((markup) => markup.includes('<msup>')), 'inline math becomes MathML');
check(tags.has('hr'), 'a horizontal rule renders');

const streaming = render('Here is a partial $\\frac{1}');
check(streaming.text.some((piece) => piece.includes('Here is a partial')), 'a half-streamed answer still shows its text');

const bare = render('\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u');
check(bare.html.length === 1 && bare.text.join('').trim() === '', 'a bare LaTeX line is treated as display math', JSON.stringify(bare.text.join('')));
const bareEnvironment = render('\\begin{aligned}\n a &= b \\\\ c &= d\n\\end{aligned}');
check(bareEnvironment.html.length === 1 && bareEnvironment.html[0].includes('<mtable>'), 'a bare LaTeX environment becomes a table', bareEnvironment.html[0]?.slice(0, 80));
const contour = math('\\oint_{\\partial \\Omega} \\vec{E} \\cdot d\\vec{A}');
check(contour.includes('∮') && contour.includes('<mover'), 'a contour integral draws its own glyph and an arrow accent', contour.slice(0, 160));

const notMath = render('It costs $100 and $200 total.');
check(!notMath.html.some((markup) => markup.includes('math')), 'prices are not mistaken for math');
check(notMath.text.join('').includes('$100'), 'the price text survives verbatim');
//#endregion

//#region decoding
/** ASCII text as bytes. */
const ascii = (value) => [...value].map((character) => character.charCodeAt(0));
const gbkHello = Uint8Array.from([...ascii('hello '), 0xc4, 0xe3, 0xba, 0xc3]);
const decodedGbk = internal.decodeUploadText(gbkHello);
check(decodedGbk.encoding === 'gbk' && decodedGbk.text === 'hello 你好', 'GBK bytes decode to Chinese', `${decodedGbk.encoding}/${decodedGbk.text}`);
check(!decodedGbk.binary, 'GBK text is not reported as binary');

const big5 = Uint8Array.from([0xa4, 0xa4, 0xa4, 0xe5]);
const decodedBig5 = internal.decodeUploadText(big5);
check(decodedBig5.text === '中文', 'Big5 bytes decode to Chinese', `${decodedBig5.encoding}/${decodedBig5.text}`);

const utf8 = new TextEncoder().encode('你好 world');
const decodedUtf8 = internal.decodeUploadText(utf8);
check(decodedUtf8.encoding === 'utf-8' && decodedUtf8.text === '你好 world', 'UTF-8 decodes as itself');

const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('bom text')]);
check(internal.decodeUploadText(utf8Bom).text === 'bom text', 'a UTF-8 byte-order mark is stripped');

const utf16 = new Uint8Array(20);
const utf16Text = 'hi 你好';
[...utf16Text].forEach((character, index) => {
	const code = character.charCodeAt(0);
	utf16[index * 2] = code & 0xff;
	utf16[index * 2 + 1] = code >> 8;
});
const decodedUtf16 = internal.decodeUploadText(utf16.subarray(0, utf16Text.length * 2));
check(decodedUtf16.text === utf16Text, 'UTF-16LE without a mark is recognised', `${decodedUtf16.encoding}/${decodedUtf16.text}`);

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x00]);
const decodedPng = internal.decodeUploadText(png);
check(decodedPng.binary === true && decodedPng.text === '', 'a PNG is reported as binary instead of mojibake', decodedPng.encoding);

const binaryNoise = Uint8Array.from({ length: 200 }, (_, index) => (index * 37 + 128) & 0xff);
check(internal.decodeUploadText(binaryNoise).binary === true, 'random high bytes are refused as text');
check(internal.decodeUploadText(new Uint8Array(0)).text === '', 'an empty file decodes to empty text');
check(internal.decodeUploadText(new TextEncoder().encode('plain ascii')).text === 'plain ascii', 'plain ASCII is unchanged');

const page = '<html><head><style>p{color:red}</style><script>var a = 1;</script></head><body><h1>Title</h1><p>First &amp; second</p><ul><li>one</li><li>two</li></ul></body></html>';
const pageText = internal.htmlToText(page);
check(!pageText.includes('<') && pageText.includes('First & second'), 'a saved web page is read as its text', JSON.stringify(pageText));
check(pageText.includes('one') && pageText.includes('Title') && !pageText.includes('color:red'), 'page script and style are dropped, headings and lists kept');
//#endregion

//#region a GBK notebook end to end
const gbkNotebook = Uint8Array.from([
	...ascii('Notebook[{\nCell["'),
	0xc4, 0xe3, 0xba, 0xc3, // 你好
	...ascii('", "Text"],\nCell[BoxData[RowBox[{"Total", "[", "x", "]"}]], "Input"]\n}]'),
]);
const decodedNotebook = internal.decodeUploadText(gbkNotebook);
check(decodedNotebook.encoding === 'gbk' && decodedNotebook.text.includes('你好'), 'a GBK notebook decodes before parsing', decodedNotebook.encoding);
const notebookText = internal.mathematicaToText(decodedNotebook.text, 'nb', (key) => key).text;
check(notebookText.includes('你好'), 'the notebook prose keeps its Chinese');
check(notebookText.includes('Total[x]'), 'the notebook input cell is still flattened', notebookText);
//#endregion

console.log('');
if (failures.length > 0) {
	console.log(`${failures.length} check(s) failed`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exit(1);
}
console.log('all checks passed');
