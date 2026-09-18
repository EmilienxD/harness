/* Run: npx -y --package jsdom@26.1.0 node tests/unit/grill_lavish_board.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const packageDir = process.env.PATH.split(path.delimiter)
  .map(bin => path.resolve(bin, '..', 'jsdom'))
  .find(dir => fs.existsSync(path.join(dir, 'package.json')));
const { JSDOM } = createRequire(path.join(packageDir, 'package.json'))(packageDir);
const template = fs.readFileSync(path.resolve(__dirname, '../../harness/planning/grill-me-in-lavish/assets/board-template.html'), 'utf8');
const question = {
  id: 'Q1', question: 'When should publication happen?',
  explanation_html: '<p>Publishing commits the round.</p><table><tr><th>Mode</th><td>Automatic</td></tr></table><label>Preview<select><option>Before</option><option>After</option></select></label><output>Before</output>',
  init_js: "root.dataset.initialized = 'yes'; root.querySelector('select').addEventListener('change', event => { root.querySelector('output').textContent = event.target.value; });",
  recommendation: 'B',
  options: [
    { letter: 'A', label: 'Automatic', detail: 'One write publishes.' },
    { letter: 'B', label: 'Explicit', detail: 'A separate action publishes.' },
  ],
};
const data = { round: 1, questions: [question, { ...question, id: 'Q2', question: 'Should partial submission be allowed?' }] };
const queued = new Map();
let submissions = 0;
const dom = new JSDOM(template.replace('__GRILL_ME_DATA__', JSON.stringify(data).replaceAll('<', '\\u003c')), {
  runScripts: 'dangerously', url: 'http://localhost/board.html',
  beforeParse(window) {
    window.lavish = {
      queuePrompt(prompt, options) { queued.set(options.queueKey, prompt); },
      sendQueuedPrompts() { submissions++; },
    };
  },
});
const { document, Event } = dom.window;
assert.equal(document.querySelectorAll('input[type=radio]:checked').length, 0);
assert.equal(document.querySelectorAll('.recommendation').length, 0);
assert.equal(document.querySelector('#board-title'), null);
assert.equal(document.querySelector('#board-subtitle'), null);
assert.equal(document.querySelectorAll('.explanation table').length, 2);
assert.equal(document.querySelector('#explanation-Q1').dataset.initialized, 'yes');
const forms = document.querySelectorAll('.answer-form');
assert.equal(forms[0].querySelector('.rec-badge').closest('label').querySelector('input').value, 'B');
const preview = document.querySelector('#explanation-Q1 select');
preview.value = 'After';
preview.dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(document.querySelector('#explanation-Q1 output').textContent, 'After');
assert.equal(queued.size, 0);
forms[0].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(queued.size, 0);
const radio = forms[0].querySelector('input[value=B]');
radio.checked = true;
radio.dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(queued.size, 0);
forms[0].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(queued.size, 1);
assert.match([...queued.values()][0], /Choice: B: Explicit/);
const note = forms[0].querySelector('textarea');
note.value = 'Keep this reversible';
note.dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(document.querySelector('#submit-round').disabled, true);
forms[0].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(queued.size, 1);
assert.match([...queued.values()][0], /Keep this reversible/);
assert.equal(document.querySelector('#submit-round').disabled, false);
document.querySelector('#submit-round').click();
assert.equal(submissions, 1);
assert.equal(queued.size, 1);
assert.equal(forms[1].closest('.question').querySelector('.state').textContent, 'open');
assert.equal(forms[0].querySelector('input').disabled, true);
document.querySelector('#submit-round').click();
assert.equal(submissions, 1);
dom.window.close();
const ownQueued = [];
const own = new JSDOM(template.replace('__GRILL_ME_DATA__', JSON.stringify({ round: 2, questions: [question] })), {
  runScripts: 'dangerously',
  beforeParse(window) { window.lavish = { queuePrompt(prompt) { ownQueued.push(prompt); } }; },
});
const ownForm = own.window.document.querySelector('.answer-form');
ownForm.querySelector('input').checked = true;
ownForm.querySelector('.text-link').click();
assert.equal(ownForm.querySelector('input:checked'), null);
ownForm.querySelector('textarea').value = 'Publish after validating supporting assets';
ownForm.dispatchEvent(new own.window.Event('submit', { cancelable: true }));
assert.match(ownQueued[0], /My own answer: Publish after validating supporting assets/);
assert.doesNotMatch(ownQueued[0], /Choice:/);
own.window.close();
const completed = new JSDOM(template.replace('__GRILL_ME_DATA__', JSON.stringify({ round: 2, complete: true, summary: 'Write assets before publishing.' })), { runScripts: 'dangerously' });
assert.equal(completed.window.document.querySelectorAll('.answer-form').length, 0);
assert.match(completed.window.document.querySelector('#app').textContent, /Write assets before publishing\./);
completed.window.close();
console.log('Board interaction checks passed');
