/** Settings sheet: every change is saved right away. */
import type { Language, Source } from '../src/shared/types.ts';
import { api } from './api.ts';
import { bridgeSetup, numberField, sensorPicker, targetPicker } from './components.ts';
import { errorText, h, icon, replace, t, toast } from './dom.ts';
import { saveConfig, store } from './store.ts';

const REPO_URL = 'https://github.com/SiM07/wattlight';
const TRANSITIONS = [0, 4, 10, 20]; // tenths of a second

/** A line showing the current value, with a "Change" button revealing the editor. */
function expandable(summary: () => string, editor: (close: () => void) => HTMLElement): HTMLElement {
  const root = h('div', { class: 'expandable' });
  const collapse = () =>
    replace(
      root,
      h('div', { class: 'row spread' }, h('span', { class: 'value', text: summary() }), h('button', { class: 'ghost small', onclick: expand }, t('action.change'))),
    );
  const expand = () => replace(root, editor(collapse));
  collapse();
  return root;
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'settings-section' }, h('h3', { text: title }), ...children);
}

function sensorSummary(kind: Source): string {
  const device = store.config[kind === 'power' ? 'powerMeter' : 'hrm'];
  return `${t('source', {}, kind)} · ${device ? (device.name ?? device.id) : t('settings.sensorAuto')}`;
}

export function openSettings(onClose: () => void = () => {}): void {
  document.querySelector('.sheet-backdrop')?.remove();
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const brightness = h('input', { type: 'range', min: 1, max: 254, value: String(store.config.brightness), 'aria-label': t('settings.brightness') });
  const brightnessValue = h('output', { text: `${Math.round((store.config.brightness / 254) * 100)} %` });
  brightness.addEventListener('input', () => (brightnessValue.textContent = `${Math.round((Number(brightness.value) / 254) * 100)} %`));
  brightness.addEventListener('change', () => saveConfig({ brightness: Number(brightness.value) }).catch((err) => toast(errorText(err), 'error')));

  const transition = h(
    'select',
    { 'aria-label': t('settings.transition') },
    ...TRANSITIONS.map((ds) => h('option', { value: String(ds), selected: store.config.transitionDs === ds, text: `${ds / 10} s` })),
  );
  transition.addEventListener('change', () => saveConfig({ transitionDs: Number(transition.value) }).then(() => toast(t('settings.saved'))).catch((err) => toast(errorText(err), 'error')));

  const restore = h('input', { type: 'checkbox', checked: store.config.restoreOnExit });
  restore.addEventListener('change', () => saveConfig({ restoreOnExit: restore.checked }).then(() => toast(t('settings.saved'))).catch((err) => toast(errorText(err), 'error')));

  const language = h(
    'select',
    { 'aria-label': t('settings.language') },
    h('option', { value: '', selected: store.config.language === null, text: t('settings.languageAuto') }),
    h('option', { value: 'en', selected: store.config.language === 'en', text: 'English' }),
    h('option', { value: 'fr', selected: store.config.language === 'fr', text: 'Français' }),
  );
  language.addEventListener('change', async () => {
    try {
      await saveConfig({ language: (language.value || null) as Language | null });
      close();
      openSettings(onClose); // rebuilt in the new language
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  const testButton = h('button', { class: 'secondary', disabled: store.session.testing }, icon('palette'), t('action.testColors'));
  testButton.addEventListener('click', () => api.post('session/test-colors').catch((err) => toast(errorText(err), 'error')));

  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h(
      'header',
      { class: 'sheet-header' },
      h('h2', { id: 'settings-title', text: t('settings.title') }),
      h('button', { class: 'icon-button', title: t('action.close'), 'aria-label': t('action.close'), onclick: close, html: icon('close').innerHTML }),
    ),
    h(
      'div',
      { class: 'sheet-body' },
      section(
        t('settings.profile'),
        numberField({ key: 'ftp', label: t('settings.ftp'), hint: t('settings.ftpHint'), min: 50, max: 2000 }),
        numberField({ key: 'maxHr', label: t('settings.maxHr'), hint: t('settings.maxHrHint'), min: 100, max: 240 }),
      ),
      section(
        t('settings.lights'),
        h('div', { class: 'field' }, h('span', { text: t('settings.target') }), expandable(() => store.config.target?.name ?? '-', (done) => targetPicker(done))),
        h('label', { class: 'field' }, h('span', { text: t('settings.brightness') }), h('div', { class: 'row' }, brightness, brightnessValue)),
        h('label', { class: 'field' }, h('span', { text: t('settings.transition') }), transition),
        h('label', { class: 'check' }, restore, h('span', { text: t('settings.restore') })),
        testButton,
      ),
      section(
        t('settings.sensors'),
        expandable(() => sensorSummary('power'), () => sensorPicker('power')),
        expandable(() => sensorSummary('hr'), () => sensorPicker('hr')),
      ),
      section(
        t('settings.bridge'),
        expandable(
          () => t('settings.bridgeConnected', { ip: store.config.bridgeIp ?? '-' }),
          (done) => bridgeSetup(() => done()),
        ),
      ),
      section(t('settings.language'), language),
      section(
        t('settings.about'),
        h('p', { class: 'muted' }, t('settings.version', { version: store.app.version }), ' · ', h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer', text: 'GitHub' })),
        h('p', { class: 'muted small-print', text: t('settings.configPath', { path: store.app.configPath }) }),
        h(
          'button',
          {
            class: 'ghost danger',
            onclick: () => api.post('quit').then(() => document.body.classList.add('quitting')),
          },
          t('action.quit'),
        ),
      ),
    ),
  );

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e: MouseEvent) => e.target === backdrop && close() }, sheet);
  document.body.append(backdrop);
  sheet.querySelector<HTMLElement>('button')?.focus();
}
