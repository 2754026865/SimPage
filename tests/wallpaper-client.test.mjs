import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/scripts/pages/home.js', import.meta.url), 'utf8');
const scheduling = source.slice(source.indexOf('function removeWallpaper()'), source.indexOf('function updateFooter('));
const loading = source.slice(source.indexOf('function loadWallpaper('), source.indexOf('function startClockUpdates('));

function harness() {
  const images = [];
  const timers = new Map();
  const idle = [];
  const classes = new Set();
  const style = { backgroundImage: '', removeProperty(name) { delete this[name]; } };
  let nextTimer = 0;
  const app = vm.createContext({
    wallpaperContainer: {
      style,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    },
    Image: class {
      constructor() { images.push(this); }
      removeAttribute(name) { delete this[name]; }
    },
    window: {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    console: { warn() {}, error() {} },
    scheduleNonCriticalTask(callback) { idle.push(callback); },
  });
  vm.runInContext(`let wallpaperTaskToken = 0;\n${scheduling}\n${loading}`, app);
  return {
    app, images, timers, classes, style,
    update(enabled, url) { app.scheduleWallpaperUpdate(enabled, url); while (idle.length) idle.shift()(); },
  };
}

test('default and saved legacy wallpaper use the same-origin daily endpoint', () => {
  for (const url of [undefined, '', '  https://bing.img.run/uhd.php  ', '/api/wallpaper']) {
    const h = harness();
    h.update(true, url);
    assert.equal(h.images[0].src, '/api/wallpaper');
    h.images[0].onload();
    assert.equal(h.style.backgroundImage, 'url("/api/wallpaper")');
    assert.ok(h.classes.has('loaded'));
    assert.equal(h.timers.size, 0);
  }
});

test('disable and re-enable remove stale inline opacity and display the new image', () => {
  const h = harness();
  h.style.opacity = '0';
  h.update(false);
  assert.equal(h.style.opacity, undefined);
  h.update(true, 'https://example.com/wallpaper.jpg');
  h.images[0].onload();
  assert.ok(h.classes.has('loaded'));
  assert.equal(h.style.opacity, undefined);
});

test('an old image cannot replace a newer wallpaper', () => {
  const h = harness();
  h.update(true, 'https://example.com/old.jpg');
  h.update(true, 'https://example.com/new.jpg');
  h.images[1].onload();
  h.images[0].onload();
  assert.equal(h.style.backgroundImage, 'url("https://example.com/new.jpg")');
  assert.equal(h.timers.size, 0);
});

test('disabled wallpaper rejects both late success and late failure', () => {
  for (const event of ['onload', 'onerror']) {
    const h = harness();
    h.update(true, 'https://example.com/slow.jpg');
    h.update(false);
    h.images[0][event]();
    assert.equal(h.images.length, 1);
    assert.equal(h.style.backgroundImage, '');
    assert.equal(h.classes.has('loaded'), false);
    assert.equal(h.timers.size, 0);
  }
});

test('custom image failure falls back once and default failure stops', () => {
  const h = harness();
  h.update(true, 'https://example.com/broken.jpg');
  h.images[0].onerror();
  assert.equal(h.images[1].src, '/api/wallpaper');
  h.images[1].onerror();
  assert.equal(h.images.length, 2);
  assert.equal(h.timers.size, 0);
  assert.equal(h.classes.has('loaded'), false);
});

test('timeout detaches stale callbacks and falls back without late-image overwrite', () => {
  const h = harness();
  h.update(true, 'https://example.com/hanging.jpg');
  const lateSuccess = h.images[0].onload;
  [...h.timers.values()][0]();
  assert.equal(h.images[0].onload, null);
  assert.equal(h.images[0].src, undefined);
  assert.equal(h.images[1].src, '/api/wallpaper');
  h.images[1].onload();
  lateSuccess();
  assert.equal(h.style.backgroundImage, 'url("/api/wallpaper")');
  assert.equal(h.timers.size, 0);
});
