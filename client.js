/**
 * Client (browser) half of dsh-plugin-agnes-image.
 *
 * It contributes one page to the Settings modal — `settings.section` — that
 * manages the Agnes API key. The key is written through the built-in credential
 * remote (`remote.credentials.set` / `unset`), the same seam the built-in
 * Models page uses for provider keys, so:
 *
 *   - the value is stored in the DSH credential store, never in the plugin row,
 *     `cordis.patch.yml`, the repository, or a tool result;
 *   - the stored value is never read back into the browser: `describe` returns
 *     redacted facts only, so the input always starts empty;
 *   - the Host resolves the key per generation with `ctx.credentials.resolve`,
 *     so saving here takes effect on the next tool call without a restart.
 *
 * This is a fragment wrapped by the loader envelope, not an ES module: every
 * bare specifier comes from the envelope's `require` (React is the only one).
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-agnes-image',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Copy namespace owned by this page. */
    const NS = 'settings.agnes-image';

    /** Credential reference the Host resolves. Keep in sync with lib/config.js. */
    const CREDENTIAL_REF = 'AGNES_API_KEY';

    const zh = {
      nav: 'Agnes 生图',
      credentialTitle: 'API Key',
      configured: '已配置',
      missing: '未配置',
      checking: '读取中…',
      keyLabel: 'Agnes API Key',
      placeholder: '粘贴 API Key（只写不回显）',
      show: '显示',
      hide: '隐藏',
      save: '保存',
      saving: '保存中…',
      clear: '移除',
      clearing: '移除中…',
      confirmClear: '确认移除',
      clearHint: '再次点击「确认移除」，已存的 Key 会被删除。',
      saved: '已保存，下一次生图生效。',
      cleared: '已移除已存的 Key。',
      readonly: '当前部署不允许通过界面写入凭据，请改用部署方配置的环境变量。',
      loadFailed: '读取凭据状态失败',
      retry: '重试',
      saveFailed: '保存失败',
      clearFailed: '移除失败',
      errEmpty: '请输入 API Key 再保存。',
      errChars: 'API Key 只能包含可打印 ASCII 字符（不能有空格、换行或中文）。',
      errEnv: '这看起来是 NAME=value 形式的环境变量行，请只粘贴 Key 本身。',
      errQuote: '不要包含首尾引号。',
    };

    const en = {
      nav: 'Agnes Image',
      credentialTitle: 'API Key',
      configured: 'Configured',
      missing: 'Not configured',
      checking: 'Reading…',
      keyLabel: 'Agnes API Key',
      placeholder: 'Paste the API key (write-only)',
      show: 'Show',
      hide: 'Hide',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Remove',
      clearing: 'Removing…',
      confirmClear: 'Confirm removal',
      clearHint: 'Click "Confirm removal" again to delete the stored key.',
      saved: 'Saved; the next generation uses it.',
      cleared: 'Stored key removed.',
      readonly: 'This deployment does not allow credential writes from the UI; use its environment configuration instead.',
      loadFailed: 'Could not read credential state',
      retry: 'Retry',
      saveFailed: 'Save failed',
      clearFailed: 'Removal failed',
      errEmpty: 'Enter an API key before saving.',
      errChars: 'The API key must be printable ASCII (no spaces, newlines, or non-ASCII characters).',
      errEnv: 'This looks like a NAME=value environment line; paste only the key itself.',
      errQuote: 'Do not include surrounding quotes.',
    };

    const CSS = [
      '.agnes-page{display:flex;flex-direction:column;gap:16px;max-width:760px;padding-top:4px}',
      '.agnes-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.agnes-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.agnes-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.agnes-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.agnes-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}',
      '.agnes-dot-success{background:var(--dsw-alias-state-success-primary)}',
      '.agnes-dot-error{background:var(--dsw-alias-state-error-primary)}',
      '.agnes-form{display:flex;flex-direction:column;gap:8px}',
      '.agnes-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.agnes-input-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.agnes-input{flex:1 1 240px;min-width:180px;height:32px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.agnes-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.agnes-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid transparent;font:inherit;font-size:13px;line-height:30px;cursor:pointer;white-space:nowrap}',
      '.agnes-btn:disabled{opacity:.55;cursor:default}',
      '.agnes-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.agnes-btn-secondary{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.agnes-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}',
      '.agnes-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.agnes-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.agnes-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary)}',
      '.agnes-ok{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-success-primary)}',
    ].join('');

    /**
     * Extract the message from a Remote failure envelope.
     * @param {unknown} response - `{ ok: false, error: { message } }` or anything else.
     * @param {string} fallback - text when the envelope carries no message.
     * @returns {string} the message to show the user.
     */
    function failureText(response, fallback) {
      const message = response && typeof response === 'object' && response.error && response.error.message;
      return typeof message === 'string' && message.trim() !== '' ? message : fallback;
    }

    /**
     * Validate a pasted key before it leaves the browser.
     *
     * The rules mirror the built-in provider editor: a key is an HTTP header
     * value, so it must be printable ASCII, and a pasted `NAME=value` line or a
     * quoted value is a format mistake the user probably wants to fix here
     * rather than see rejected by the API.
     * @param {string} raw - the draft value.
     * @param {(key: string) => string} t - page translator.
     * @returns {string | undefined} an error message, or undefined when valid.
     */
    function validateKey(raw, t) {
      const value = raw.trim();
      if (value === '') return t('errEmpty');
      if (!/^[\x21-\x7E]+$/.test(value)) return t('errChars');
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value)) return t('errEnv');
      if (/^["']|["']$/.test(value)) return t('errQuote');
      return undefined;
    }

    /**
     * Render one settings page.
     * @param {{ api: { describe: () => Promise<object | undefined>, save: (value: string) => Promise<void>, clear: () => Promise<void> }, t: (key: string) => string }} props
     *   the credential face and translator.
     * @returns {import('react').ReactElement} the page.
     */
    function AgnesImageSection({ api, t }) {
      const [status, setStatus] = React.useState({ phase: 'loading', info: undefined, error: undefined });
      const [draft, setDraft] = React.useState('');
      const [revealed, setRevealed] = React.useState(false);
      const [busy, setBusy] = React.useState(undefined);
      const [notice, setNotice] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [confirmClear, setConfirmClear] = React.useState(false);

      const refresh = React.useCallback(async () => {
        try {
          const info = await api.describe();
          setStatus({ phase: 'ready', info, error: undefined });
        } catch (failure) {
          setStatus({
            phase: 'error',
            info: undefined,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }, [api]);

      React.useEffect(() => {
        let live = true;
        setStatus({ phase: 'loading', info: undefined, error: undefined });
        api.describe().then(
          (info) => { if (live) setStatus({ phase: 'ready', info, error: undefined }); },
          (failure) => {
            if (!live) return;
            setStatus({
              phase: 'error',
              info: undefined,
              error: failure instanceof Error ? failure.message : String(failure),
            });
          },
        );
        return () => { live = false; };
      }, [api]);

      React.useEffect(() => {
        if (!confirmClear) return undefined;
        const timer = setTimeout(() => setConfirmClear(false), 5000);
        return () => clearTimeout(timer);
      }, [confirmClear]);

      const info = status.info;
      const configured = info !== undefined && info.configured === true;
      const writable = info === undefined || info.writable !== false;
      const disabled = busy !== undefined || !writable;
      const statusText = status.phase === 'loading'
        ? t('checking')
        : configured ? t('configured') : t('missing');
      const statusTone = status.phase === 'error' ? 'error' : configured ? 'success' : 'idle';

      const submit = async (event) => {
        event.preventDefault();
        const invalid = validateKey(draft, t);
        if (invalid !== undefined) {
          setError(invalid);
          return;
        }
        setBusy('save');
        setError(undefined);
        setNotice(undefined);
        try {
          await api.save(draft.trim());
          setDraft('');
          setRevealed(false);
          setConfirmClear(false);
          await refresh();
          setNotice(t('saved'));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(undefined);
        }
      };

      const remove = async () => {
        if (!confirmClear) {
          setConfirmClear(true);
          setNotice(undefined);
          setError(undefined);
          return;
        }
        setBusy('clear');
        setError(undefined);
        setNotice(undefined);
        try {
          await api.clear();
          setConfirmClear(false);
          await refresh();
          setNotice(t('cleared'));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(undefined);
        }
      };

      const statusRow = h('span', { className: 'agnes-status', role: 'status' },
        h('span', { className: `agnes-dot agnes-dot-${statusTone}`, 'aria-hidden': true }),
        h('span', null, statusText));

      const credentialCard = h('section', { className: 'agnes-card' },
        h('div', { className: 'agnes-card-head' },
          h('h3', { className: 'agnes-card-title' }, t('credentialTitle')),
          statusRow),
        status.phase === 'error'
          ? h('div', { className: 'agnes-form' },
            h('p', { className: 'agnes-error', role: 'alert' }, t('loadFailed') + ': ' + (status.error ?? '')),
            h('div', { className: 'agnes-actions' },
              h('button', {
                type: 'button',
                className: 'agnes-btn agnes-btn-secondary',
                onClick: () => { void refresh(); },
              }, t('retry'))))
          : h('form', { className: 'agnes-form', onSubmit: submit },
            h('label', { className: 'agnes-label', htmlFor: 'agnes-api-key' }, t('keyLabel')),
            h('div', { className: 'agnes-input-row' },
              h('input', {
                id: 'agnes-api-key',
                className: 'agnes-input',
                type: revealed ? 'text' : 'password',
                value: draft,
                placeholder: t('placeholder'),
                autoComplete: 'new-password',
                autoCapitalize: 'off',
                autoCorrect: 'off',
                spellCheck: false,
                disabled,
                onChange: (event) => {
                  setDraft(event.currentTarget.value);
                  setError(undefined);
                  setNotice(undefined);
                },
              }),
              h('button', {
                type: 'button',
                className: 'agnes-btn agnes-btn-ghost',
                'aria-pressed': revealed,
                disabled,
                onClick: () => setRevealed((value) => !value),
              }, revealed ? t('hide') : t('show'))),
            h('div', { className: 'agnes-actions' },
              h('button', {
                type: 'submit',
                className: 'agnes-btn agnes-btn-primary',
                disabled: disabled || draft.trim() === '',
              }, busy === 'save' ? t('saving') : t('save')),
              configured
                ? h('button', {
                  type: 'button',
                  className: 'agnes-btn agnes-btn-secondary',
                  disabled,
                  onClick: () => { void remove(); },
                }, busy === 'clear' ? t('clearing') : confirmClear ? t('confirmClear') : t('clear'))
                : null),
            error === undefined ? null : h('p', { className: 'agnes-error', role: 'alert' }, error),
            notice === undefined ? null : h('p', { className: 'agnes-ok', role: 'status' }, notice),
            confirmClear && configured ? h('p', { className: 'agnes-hint' }, t('clearHint')) : null,
            writable ? null : h('p', { className: 'agnes-hint' }, t('readonly'))));

      return h('div', { className: 'agnes-page' },
        h('style', null, CSS),
        credentialCard);
    }

    return {
      inject: ['locale', 'remote', 'remote.credentials', 'slots'],

      /**
       * Register the settings page and its dictionaries.
       * @param {any} ctx - client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', zh);
          const disposeEn = ctx.locale.register(NS, 'en', en);
          return () => {
            disposeZh();
            disposeEn();
          };
        }, 'agnes-image: settings copy');

        const t = ctx.locale.bind(NS);
        const seam = ctx.remote.credentials;

        const api = {
          async describe() {
            const response = await seam.describe([CREDENTIAL_REF]);
            if (!response || response.ok !== true) throw new Error(failureText(response, t('loadFailed')));
            return response.value === undefined ? undefined : response.value[CREDENTIAL_REF];
          },
          async save(value) {
            const response = await seam.set(CREDENTIAL_REF, value);
            if (!response || response.ok !== true) throw new Error(failureText(response, t('saveFailed')));
          },
          async clear() {
            const response = await seam.unset(CREDENTIAL_REF);
            if (!response || response.ok !== true) throw new Error(failureText(response, t('clearFailed')));
          },
        };

        const Section = (props) => h(AgnesImageSection, { api, t, close: props.close });

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'agnes-image',
          order: 25,
          label: () => t('nav'),
        }, Section)), 'agnes-image: settings section');
      },
    };
  },
});
