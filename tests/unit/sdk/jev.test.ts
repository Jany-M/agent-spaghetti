// JEV step 2 (finish-line plan, Part I): the shipped defaults set a task's kind and difficulty; the caller's own values win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '@agent-spaghetti/sdk';

test('kind from the default word lists, English and Italian; nothing matched is other', () => {
  const kind = (t: string) => classify(t).kind;
  assert.deepEqual([
    'Summarize README.md in 3 bullets', 'Riassumi questo documento in punti chiave', 'Write unit tests for utils.ts with vitest', 'Scrivi i test unitari con copertura',
    'Refactor the auth module and rename helpers', 'Ristruttura e semplifica il modulo', 'Review this diff and find bugs', 'Rivedi e controlla questo codice, trova errori',
    'Write the README for the CLI', 'Aggiungi i commenti e la documentazione', 'Research the latest GPU cloud prices and compare sources', 'Cerca informazioni sulle ultime versioni',
    'Fix the bug in the login endpoint', 'Correggi la funzione di login', 'hello there'].map(kind),
  ['summarize', 'summarize', 'tests', 'tests', 'refactor', 'refactor', 'review', 'review', 'docs', 'docs', 'research', 'research', 'code-edit', 'code-edit', 'other']);
});
test('the action said first outweighs the topic (live run 29, 2026-11-04: a summary about unit tests is a summary)', () => {
  assert.equal(classify('Summarize in two lines why unit tests matter.').kind, 'summarize');
  assert.equal(classify('Write unit tests that check the summary function').kind, 'tests');
  assert.equal(classify('Please can you review this: it adds a new endpoint').kind, 'review');
  assert.equal(classify('In two sentences, explain what a hash map is.').kind, 'research', 'live run 35, 2026-11-04: explaining is answering a question');
  assert.equal(classify('Spiega in breve cosa fa questa funzione').kind, 'research');
});
test('confidence: the lead of the top kind over the next one; a tie goes to the more specific kind', () => {
  assert.equal(classify('Summarize the changelog').confidence, 0, 'summarize and docs tie');
  assert.equal(classify('Summarize the changelog').kind, 'docs', 'docs is more specific than summarize');
  assert.equal(classify('Summarize and condense this').confidence, 1);
  assert.equal(classify('hello').confidence, 0);
  assert.ok(classify('review and fix the bug in the endpoint').confidence < 1);
});
test('difficulty: heavy for size, heavy words or wide edits; light for short reading tasks; medium otherwise', () => {
  const d = (t: string, files = 0) => classify(t, files).difficulty;
  assert.equal(d('Summarize this'), 'light');
  assert.equal(d('Summarize this', 2), 'medium', 'more than one file');
  assert.equal(d('Fix the bug'), 'medium', 'code-edit is never light');
  assert.equal(d('Fix the bug', 3), 'heavy', 'an edit across more than two files');
  assert.equal(d('Summarize this', 6), 'heavy');
  assert.equal(d(`Summarize ${'word '.repeat(2001)}`), 'heavy');
  assert.equal(d(`Summarize ${'word '.repeat(400)}`), 'medium');
  assert.equal(d('Explain the security model'), 'heavy');
  assert.equal(d('Valuta le prestazioni del modulo'), 'heavy', 'Italian heavy words');
  assert.equal(d(`Summarize\n\`\`\`\n${'x\n'.repeat(60)}\`\`\``), 'medium', 'a long code block');
});
test('the caller\'s own kind and difficulty win; invalid values are ignored', () => {
  assert.deepEqual(classify('Summarize this', 0, { kind: 'review', difficulty: 'heavy' }), { kind: 'review', difficulty: 'heavy', by: 'caller', confidence: 1 });
  assert.deepEqual(classify('Summarize this', 0, { kind: 'nonsense', difficulty: 'huge' }), { kind: 'summarize', difficulty: 'light', by: 'rules', confidence: 1 });
});
