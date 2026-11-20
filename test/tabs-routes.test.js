'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isRoute, labelFor, projectOf } = require('../src/tabs/routes');

const BASE = 'https://clew.alefa.net/';

test('projectOf: the project a Clew address shows', () => {
  assert.equal(projectOf(`${BASE}#/p/transcript`), 'transcript');
  assert.equal(projectOf(`${BASE}#/p/writing-session/m/abc?x=1`), 'writing-session');
  assert.equal(projectOf(`${BASE}#/p/survey-entry?start=1`), 'survey-entry');
});

test('projectOf: none for the hub own pages and odd addresses', () => {
  assert.equal(projectOf(`${BASE}#/`), null);
  assert.equal(projectOf(`${BASE}#/settings`), null);
  assert.equal(projectOf(`${BASE}#/map`), null);
  assert.equal(projectOf(BASE), null);
  assert.equal(projectOf('not a url'), null);
  assert.equal(projectOf(`${BASE}#/p/%E0%A4%A`), null);
});

test('isRoute: only a hub route of sane length', () => {
  assert.equal(isRoute('#/p/notes'), true);
  assert.equal(isRoute('#/'), true);
  assert.equal(isRoute('https://example.org/#/p/notes'), false);
  assert.equal(isRoute('javascript:alert(1)'), false);
  assert.equal(isRoute(42), false);
  assert.equal(isRoute(`#/${'a'.repeat(5000)}`), false);
});

test('labelFor: the page title before the app name, else the project', () => {
  assert.equal(labelFor('Transcripts · Clew', `${BASE}#/p/transcript`, 'Clew'), 'Transcripts');
  assert.equal(labelFor('Clew', `${BASE}#/p/writing-session`, 'Clew'), 'Writing session');
  assert.equal(labelFor('', `${BASE}#/`, 'Clew'), 'Clew');
  assert.equal(labelFor('Clew', `${BASE}#/settings`, 'Clew'), 'Clew');
});
