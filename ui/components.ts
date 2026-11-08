/** Building blocks shared by the first-run setup and the settings sheet. */
import type { BridgeInfo, DeviceRef, PublicConfig, SensorDevice, Source, Target, TargetOption } from '../src/shared/types.ts';
import { api } from './api.ts';
import { errorText, h, icon, replace, spinner, t, toast } from './dom.ts';
import { saveConfig, store } from './store.ts';

const PAIR_TIMEOUT_S = 30;

/** Finds the bridges, then pairs the chosen one (link button). Calls `onPaired` once done. */
export function bridgeSetup(onPaired: (config: PublicConfig) => void): HTMLElement {
  const root = h('div', { class: 'stack' });
  let pairing: AbortController | null = null;

  const manual = h('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: '192.168.1.20',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': t('wizard.bridge.manual'),
  });

  async function startPairing(ip: string) {
    pairing?.abort();
    const controller = (pairing = new AbortController());
    let left = PAIR_TIMEOUT_S;
    const countdown = h('p', { class: 'muted centered', text: t('wizard.bridge.countdown', { seconds: left }) });
    const timer = window.setInterval(() => {
      left = Math.max(0, left - 1);
      countdown.textContent = t('wizard.bridge.countdown', { seconds: left });
    }, 1000);
    replace(
      root,
      h('div', { class: 'press-button' }, h('div', { class: 'bridge-art' }, h('span', { class: 'bridge-art-button' })), h('h3', { text: t('wizard.bridge.press') })),
      countdown,
      h('button', { class: 'ghost', onclick: () => controller.abort() }, t('action.cancel')),
    );
    try {
      const { config } = await api.post<{ config: PublicConfig }>('hue/pair', { ip }, controller.signal);
      toast(t('wizard.bridge.paired'));
      onPaired(config);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast(errorText(err), 'error');
      void search();
    } finally {
      clearInterval(timer);
      pairing = null;
    }
  }

  async function search() {
    replace(root, h('p', { class: 'muted searching' }, spinner(), t('wizard.bridge.searching')));
    let bridges: BridgeInfo[] = [];
    try {
      ({ bridges } = await api.get<{ bridges: BridgeInfo[] }>('hue/bridges'));
    } catch (err) {
      toast(errorText(err), 'error');
    }
    const list = bridges.length
      ? h(
          'div',
          { class: 'choices' },
          ...bridges.map((b) =>
            h('button', { class: 'choice', onclick: () => startPairing(b.ip) }, icon('bridge'), h('span', { class: 'choice-text' }, h('strong', { text: b.name }), h('small', { text: b.ip }))),
          ),
        )
      : h('p', { class: 'muted', text: t('wizard.bridge.none') });
    if (store.config.bridgeIp && !manual.value) manual.value = store.config.bridgeIp;
    replace(
      root,
      list,
      h(
        'form',
        {
          class: 'manual',
          onsubmit: (e: SubmitEvent) => {
            e.preventDefault();
            if (manual.value.trim()) void startPairing(manual.value.trim());
          },
        },
        h('label', {}, h('span', { text: t('wizard.bridge.manual') }), h('div', { class: 'row' }, manual, h('button', { type: 'submit', class: 'secondary' }, t('wizard.bridge.use')))),
        h('small', { class: 'muted', text: t('wizard.bridge.manualHint') }),
      ),
      h('button', { class: 'ghost', onclick: () => void search() }, icon('search'), t('action.searchAgain')),
    );
  }

  void search();
  return root;
}

function targetLabel(target: TargetOption): string {
  if (target.kind === 'light') return t('wizard.lights.light');
  return t(`wizard.lights.${target.kind}`, { count: target.lights }, target.lights === 1 ? 'one' : undefined);
}

/** Rooms, zones and color lights of the bridge, with a blink button to spot them. */
export function targetPicker(onSelect: (target: Target) => void): HTMLElement {
  const root = h('div', { class: 'choices' }, h('p', { class: 'muted searching' }, spinner()));
  api
    .get<{ targets: TargetOption[] }>('hue/targets')
    .then(({ targets }) => {
      if (!targets.length) return replace(root, h('p', { class: 'muted', text: t('wizard.lights.none') }));
      const render = () =>
        replace(
          root,
          ...targets.map((target) => {
            const selected = store.config.target?.type === target.type && store.config.target.id === target.id;
            return h(
              'div',
              { class: `choice${selected ? ' selected' : ''}` },
              h(
                'button',
                {
                  class: 'choice-main',
                  'aria-pressed': String(selected),
                  onclick: async () => {
                    try {
                      await saveConfig({ target: { type: target.type, id: target.id, name: target.name } });
                      render();
                      onSelect(target);
                    } catch (err) {
                      toast(errorText(err), 'error');
                    }
                  },
                },
                icon(selected ? 'check' : 'bulb'),
                h('span', { class: 'choice-text' }, h('strong', { text: target.name }), h('small', { text: targetLabel(target) })),
              ),
              h(
                'button',
                {
                  class: 'ghost small',
                  title: t('action.blink'),
                  onclick: () => api.post('hue/identify', { target }).catch((err) => toast(errorText(err), 'error')),
                },
                t('action.blink'),
              ),
            );
          }),
        );
      render();
    })
    .catch((err) => replace(root, h('p', { class: 'error-text', text: errorText(err) })));
  return root;
}

/** Power / heart rate cards. */
export function sourcePicker(onChange: (source: Source) => void): HTMLElement {
  const root = h('div', { class: 'choices' });
  const render = () =>
    replace(
      root,
      ...(['power', 'hr'] as const).map((source) => {
        const selected = store.config.source === source;
        return h(
          'button',
          {
            class: `choice${selected ? ' selected' : ''}`,
            'aria-pressed': String(selected),
            onclick: async () => {
              try {
                await saveConfig({ source });
                render();
                onChange(source);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            },
          },
          icon(source === 'power' ? 'bolt' : 'heart'),
          h('span', { class: 'choice-text' }, h('strong', { text: t(`source.${source}`) }), h('small', { text: t(`wizard.profile.${source}`) })),
        );
      }),
    );
  render();
  return root;
}

/** Number input saved when it loses focus or Enter is pressed. */
export function numberField(opts: { key: 'ftp' | 'maxHr'; label: string; hint?: string; min: number; max: number }): HTMLElement {
  const input = h('input', { type: 'number', inputmode: 'numeric', min: opts.min, max: opts.max, step: 1, value: String(store.config[opts.key]) });
  const error = h('small', { class: 'error-text' });
  const commit = async () => {
    const value = Number(input.value);
    if (value === store.config[opts.key]) return;
    try {
      await saveConfig({ [opts.key]: value });
      error.textContent = '';
      toast(t('settings.saved'));
    } catch (err) {
      error.textContent = errorText(err);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  return h('label', { class: 'field' }, h('span', { text: opts.label }), input, opts.hint ? h('small', { class: 'muted', text: opts.hint }) : null, error);
}

const sensorKey = (kind: Source) => (kind === 'power' ? 'powerMeter' : 'hrm');

/** "Automatic" or a specific sensor, with a Bluetooth search. */
export function sensorPicker(kind: Source): HTMLElement {
  const root = h('div', { class: 'stack' });
  let found: SensorDevice[] | null = null;
  let searching: AbortController | null = null;

  const choose = async (device: DeviceRef | null) => {
    try {
      await saveConfig({ [sensorKey(kind)]: device });
      render();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const option = (device: DeviceRef | null, label: string, detail?: string) => {
    const current = store.config[sensorKey(kind)];
    const selected = device ? current?.id === device.id : !current;
    return h(
      'button',
      { class: `choice${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), onclick: () => void choose(device) },
      icon(selected ? 'check' : kind === 'power' ? 'bolt' : 'heart'),
      h('span', { class: 'choice-text' }, h('strong', { text: label }), detail ? h('small', { text: detail }) : null),
    );
  };

  async function search() {
    searching?.abort();
    const controller = (searching = new AbortController());
    render();
    try {
      ({ devices: found } = await api.post<{ devices: SensorDevice[] }>('sensors/scan', { kind }, controller.signal));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast(errorText(err), 'error');
      found ??= [];
    } finally {
      if (searching === controller) searching = null;
      render();
    }
  }

  function render() {
    const current = store.config[sensorKey(kind)];
    const devices = [...(found ?? [])];
    if (current && !devices.some((d) => d.id === current.id)) devices.unshift({ ...current, rssi: null });
    replace(
      root,
      h(
        'div',
        { class: 'choices' },
        option(null, t('wizard.sensor.auto', { device: t('device', {}, kind) })),
        ...devices.map((d) => option(d, d.name ?? d.id, d.rssi === null ? undefined : `${d.rssi} dBm`)),
      ),
      found?.length === 0 && !searching ? h('p', { class: 'muted', text: t('wizard.sensor.none') }) : null,
      searching
        ? h('p', { class: 'muted searching' }, spinner(), t('status.suspended'))
        : h('button', { class: 'secondary', onclick: () => void search() }, icon('search'), t(found ? 'action.searchAgain' : 'action.search')),
    );
  }

  render();
  return root;
}
