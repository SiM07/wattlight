/** Main screen: live value, zone, sensor status and the power / heart rate switch. */
import { describeStatus } from '../src/shared/i18n.ts';
import type { PublicZone, Source, StateResponse } from '../src/shared/types.ts';
import { api, subscribe } from './api.ts';
import { errorText, getLanguage, h, icon, replace, t, toast } from './dom.ts';
import { openSettings } from './settings.ts';
import { init, needsSetup, onChange, saveConfig, setConfig, setSession, store } from './store.ts';
import { openWizard } from './wizard.ts';

const NEUTRAL = '#4B5263';
const LEVEL_ICON = { info: 'info', ok: 'check', warn: 'alert', error: 'alert' } as const;

const zoneLabel = (zone: PublicZone) => `Z${zone.number} · ${translateZone(zone.name)}`;
function translateZone(name: string): string {
  const key = `zone.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

function setAccent(color: string): void {
  document.documentElement.style.setProperty('--zone', color);
}

/** Builds the dashboard once; `update` then patches the moving parts on every state event. */
function dashboard(root: HTMLElement) {
  const value = h('span', { class: 'value' });
  const unit = h('span', { class: 'unit' });
  const pct = h('div', { class: 'pct' });
  const zoneName = h('div', { class: 'zone-name' });
  const gauge = h('div', { class: 'gauge' }, h('div', { class: 'gauge-ring' }, h('div', { class: 'gauge-inner' }, value, unit)), pct, zoneName);

  const statusIcon = h('span', { class: 'icon' });
  const statusTitle = h('strong');
  const statusHint = h('small');
  const status = h('div', { class: 'status', role: 'status' }, statusIcon, h('div', { class: 'status-text' }, statusTitle, statusHint));
  const hueAlert = h('div', { class: 'status hue-alert', 'data-level': 'error', hidden: true }, icon('bulb'), h('div', { class: 'status-text' }, h('strong')));

  const zones = h('div', { class: 'zones', 'aria-label': t('zones.title') });
  const sourceButtons = (['power', 'hr'] as const).map((source) =>
    h(
      'button',
      {
        role: 'radio',
        dataset: { source },
        onclick: () => switchSource(source),
      },
      icon(source === 'power' ? 'bolt' : 'heart'),
      t(`source.${source}`),
    ),
  );
  const toggle = h('button', { class: 'secondary wide', onclick: () => void toggleRunning() });

  replace(
    root,
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: '/ui/icon.svg', alt: '' }), h('span', { text: 'WattLight' })),
      store.session.demo ? h('span', { class: 'badge', text: t('app.demo') }) : null,
      h('button', { class: 'icon-button', title: t('action.settings'), 'aria-label': t('action.settings'), onclick: () => openSettings(), html: icon('gear').innerHTML }),
    ),
    h('div', { class: 'segmented', role: 'radiogroup' }, ...sourceButtons),
    gauge,
    status,
    hueAlert,
    zones,
    h('footer', { class: 'actions' }, toggle),
  );

  async function switchSource(source: Source) {
    if (store.config.source === source) return;
    try {
      await saveConfig({ source });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function toggleRunning() {
    toggle.disabled = true;
    try {
      await api.post(store.session.running ? 'session/stop' : 'session/start');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      toggle.disabled = false;
    }
  }

  let testUntil = 0;
  function showTest(zone: PublicZone) {
    testUntil = Date.now() + 1600;
    setAccent(zone.color);
    value.textContent = '';
    unit.textContent = '';
    pct.textContent = t('action.testColors');
    zoneName.textContent = zoneLabel(zone);
    markZone(zone.number);
  }

  function markZone(number: number | null) {
    for (const el of zones.children) el.classList.toggle('active', Number((el as HTMLElement).dataset.zone) === number);
  }

  function update() {
    const { session, config } = store;
    for (const button of sourceButtons) button.setAttribute('aria-checked', String(button.dataset.source === session.source));

    // Live value and zone.
    if (Date.now() > testUntil) {
      const live = session.value !== null && session.zone !== null;
      value.textContent = live ? String(session.value) : '–';
      unit.textContent = session.unit;
      pct.textContent = live ? `${session.pct} % ${t('reference', {}, session.source)}` : `${t('reference', {}, session.source)} ${session.reference} ${session.unit}`;
      zoneName.textContent = session.zone ? zoneLabel(session.zone) : '';
      setAccent(live && session.zone ? session.zone.color : NEUTRAL);
      gauge.classList.toggle('idle', !live);
      markZone(live ? session.zone!.number : null);
    }

    // Sensor status.
    const configuredDevice = session.source === 'power' ? config.powerMeter : config.hrm;
    const { title, hint } = describeStatus(getLanguage(), session.status, session.source, session.device?.name ?? configuredDevice?.name);
    status.dataset.level = session.status.level;
    statusIcon.innerHTML = icon(LEVEL_ICON[session.status.level]).innerHTML;
    statusTitle.textContent = title;
    statusHint.textContent = hint ?? '';
    statusHint.hidden = !hint;

    // Hue bridge problem.
    hueAlert.hidden = !session.hue.problem;
    if (session.hue.problem) hueAlert.querySelector('strong')!.textContent = t(`hue.${session.hue.problem}`, { ip: config.bridgeIp });

    // Zone strip.
    const key = session.zones.map((z) => `${z.number}${z.color}${z.from}`).join();
    if (zones.dataset.key !== key) {
      zones.dataset.key = key;
      replace(
        zones,
        ...session.zones.map((z) =>
          h(
            'div',
            { class: 'zone', dataset: { zone: String(z.number) }, title: `${zoneLabel(z)} · ${t('zones.from', { from: z.from, unit: session.unit })}`, style: { '--c': z.color } },
            h('i'),
            h('span', { text: `Z${z.number}` }),
            h('small', { text: String(z.from) }),
          ),
        ),
      );
      markZone(session.zone?.number ?? null);
    }

    toggle.replaceChildren(icon(session.running ? 'pause' : 'play'), t(session.running ? 'action.pause' : 'action.resume'));
    toggle.hidden = !session.configured;
  }

  update();
  return { update, showTest };
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    init(await api.get<StateResponse>('state'));
  } catch (err) {
    replace(root, h('div', { class: 'fatal' }, icon('alert'), h('p', { text: errorText(err) })));
    return;
  }

  let view = dashboard(root);
  let language = getLanguage();
  onChange(() => {
    if (getLanguage() !== language) {
      language = getLanguage();
      view = dashboard(root); // static texts follow the new language
    } else {
      view.update();
    }
  });

  const offline = h('div', { class: 'offline', hidden: true }, icon('alert'), h('span', { text: t('error.connection') }));
  document.body.append(offline);
  subscribe({
    state: setSession,
    config: setConfig,
    test: (zone) => view.showTest(zone),
    connection: (online) => {
      offline.hidden = online || document.body.classList.contains('quitting');
    },
  });

  if (needsSetup(store.config)) openWizard(() => void api.post('session/start').catch(() => {}));
}

void boot();
