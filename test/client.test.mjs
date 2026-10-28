/**
 * Client-half test without a DOM or React install.
 *
 * The browser bundle is a loader fragment, so the test evaluates it with a stub
 * window, runs `apply()` against a fake client context, and renders the
 * registered section with a stub `createElement`. That covers the parts that
 * break silently in production: the module id, the inject face, the slot
 * registration, localized copy, the masked input, and the credential-seam
 * wrappers (including failure text).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const CLIENT_PATH = join(import.meta.dirname, '..', 'client.js');

/** A React stub that produces inspectable element trees and runs hooks once. */
function createReactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect() {},
  };
}

/** Load the fragment and return its plugin factory. */
async function loadPlugin(react) {
  const source = await readFile(CLIENT_PATH, 'utf8');
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  new Function('window', source)(globalThis.window);
  assert.ok(captured, 'client.js must call window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-plugin-agnes-image');
  return captured.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  });
}

/** Build a fake client context with a recording credential seam. */
function createContext({ seam, dictionaries }) {
  const registrations = [];
  const effects = [];
  return {
    registrations,
    context: {
      effect(callback) {
        const dispose = callback();
        effects.push(dispose);
        return () => {};
      },
      locale: {
        register(ns, locale, dict) {
          dictionaries.set(`${ns}|${locale}`, dict);
          return () => {};
        },
        bind(ns) {
          return (key) => (dictionaries.get(`${ns}|zh`) ?? {})[key] ?? key;
        },
      },
      remote: { credentials: seam },
      slots: {
        inject(_name, register) {
          return register();
        },
        register(options, Component) {
          registrations.push({ options, Component });
          return () => {};
        },
      },
    },
  };
}

/** Expand function components so the stub tree is inspectable like rendered DOM. */
function expand(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 12) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props), depth + 1);
  return {
    ...node,
    children: (node.children ?? []).map((child) => expand(child, depth + 1)),
  };
}

/** Depth-first search of the expanded stub element tree. */
function findElement(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('client settings section', () => {
  test('registers one settings page with localized copy', async () => {
    const dictionaries = new Map();
    const seam = {
      describe: async () => ({ ok: true, value: { AGNES_API_KEY: { configured: false, writable: true } } }),
      set: async () => ({ ok: true, value: undefined }),
      unset: async () => ({ ok: true, value: undefined }),
    };
    const { context, registrations } = createContext({ seam, dictionaries });
    const plugin = await loadPlugin(createReactStub());

    assert.deepEqual(plugin.inject, ['locale', 'remote', 'remote.credentials', 'slots']);
    plugin.apply(context);

    assert.equal(registrations.length, 1);
    const { options } = registrations[0];
    assert.equal(options.name, 'settings.section');
    assert.equal(options.id, 'agnes-image');
    assert.equal(options.order, 25);
    assert.equal(options.label(), 'Agnes 生图', 'the nav label follows the zh dictionary');
    assert.deepEqual([...dictionaries.keys()].sort(), ['settings.agnes-image|en', 'settings.agnes-image|zh']);
  });

  test('renders a masked, write-only key field', async () => {
    const dictionaries = new Map();
    const seam = {
      describe: async () => ({ ok: true, value: { AGNES_API_KEY: { configured: true, source: 'store', writable: true } } }),
      set: async () => ({ ok: true, value: undefined }),
      unset: async () => ({ ok: true, value: undefined }),
    };
    const { context, registrations } = createContext({ seam, dictionaries });
    const plugin = await loadPlugin(createReactStub());
    plugin.apply(context);

    const tree = expand(registrations[0].Component({ close() {} }));
    const input = findElement(tree, (node) => node.type === 'input');
    assert.ok(input, 'the page renders an input');
    assert.equal(input.props.type, 'password');
    assert.equal(input.props.autoComplete, 'new-password');
    assert.equal(input.props.value, '');

    const buttons = [];
    const visit = (node) => {
      if (node === null || typeof node !== 'object') return;
      if (node.type === 'button') buttons.push(...(node.children ?? []));
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    assert.ok(buttons.includes('保存'), 'the save action exists');

    const markup = JSON.stringify(tree);
    assert.equal(/sk-[A-Za-z0-9]{8,}/.test(markup), false, 'no key-like string is rendered');
    assert.equal(markup.includes('使用方式'), false, 'the page keeps only the form, no explanatory card');
    assert.equal(markup.includes('存放位置'), false, 'no storage explainer line');
    assert.equal(markup.includes('输入框留空'), false, 'no hint paragraph under the field');
  });

  test('writes, reads, and clears through the credential seam', async () => {
    const dictionaries = new Map();
    const calls = [];
    const seam = {
      async describe(refs) {
        calls.push(['describe', refs]);
        return { ok: true, value: { AGNES_API_KEY: { configured: true, writable: true } } };
      },
      async set(ref, value) {
        calls.push(['set', ref, value]);
        return { ok: true, value: undefined };
      },
      async unset(ref) {
        calls.push(['unset', ref]);
        return { ok: true, value: undefined };
      },
    };
    const { context, registrations } = createContext({ seam, dictionaries });
    const plugin = await loadPlugin(createReactStub());
    plugin.apply(context);

    const api = registrations[0].Component({ close() {} }).props.api;
    const info = await api.describe();
    assert.equal(info.configured, true);
    await api.save('sk-test-value');
    await api.clear();

    assert.deepEqual(calls, [
      ['describe', ['AGNES_API_KEY']],
      ['set', 'AGNES_API_KEY', 'sk-test-value'],
      ['unset', 'AGNES_API_KEY'],
    ]);
  });

  test('surfaces credential-seam failures instead of pretending success', async () => {
    const dictionaries = new Map();
    const seam = {
      describe: async () => ({ ok: false, error: { message: 'store offline' } }),
      set: async () => ({ ok: false, error: { message: 'write refused' } }),
      unset: async () => ({ ok: false, error: { message: 'remove refused' } }),
    };
    const { context, registrations } = createContext({ seam, dictionaries });
    const plugin = await loadPlugin(createReactStub());
    plugin.apply(context);
    const api = registrations[0].Component({ close() {} }).props.api;

    await assert.rejects(api.describe(), /store offline/);
    await assert.rejects(api.save('sk-x'), /write refused/);
    await assert.rejects(api.clear(), /remove refused/);
  });
});
