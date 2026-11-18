import type { FieldError } from '../server/config';
import type { Detected, TomcatFound } from '../server/setup-detect';
import { CHROME_LAUNCH_EVENT, chromeLaunchNote, startChrome } from './chrome';
import { h, type Child } from './dom';
import type { SettingsKit } from './settings';

/**
 * The setup guide: every setting, one step at a time, in plain words. It is a dialog over the
 * settings screen and edits the same draft with the same controls (handed over as `kit`, so the
 * live checks behind them, "3 log files found", work here too). Nothing is saved until the last
 * step, or a "save and try it" button; closing it leaves the answers in Settings, unsaved.
 *
 * Steps follow what the user said they work with on the first page: someone without Postgres
 * never sees the Postgres step. Every value says whether it is needed, what it does, what it
 * looks like, and where to find it; where the hub can find a value itself (setup-detect.ts),
 * it offers what it found.
 */

type Topic = 'browser' | 'tomcatLogs' | 'tomcatServer' | 'postgres' | 'editor' | 'api';
type Need = 'required' | 'recommended' | 'optional';

interface Step {
  id: string;
  /** Short name, for the list of steps. */
  rail: string;
  title: string;
  icon: string;
  /** Settings this step asks for: save errors under these go to it. */
  paths: string[];
  when?: (t: Set<Topic>) => boolean;
  /** What is filled in, in a few words; null when nothing yet. */
  summary?: () => string | null;
  /** What is still missing for this step to do anything, in words; null when nothing is. */
  needs?: () => string | null;
  render: () => Child[];
}

interface Options {
  firstRun: boolean;
  onClose: () => void;
}

let k: SettingsKit;
const G = {
  dialog: null as HTMLDialogElement | null,
  topics: new Set<Topic>(),
  steps: [] as Step[],
  index: 0,
  visited: new Set<string>(),
  errors: [] as FieldError[],
  saved: false,
  detected: null as Detected | null,
  detecting: null as Promise<Detected | null> | null,
  opts: null as Options | null,
};

export const guideOpen = () => !!G.dialog;

// ── Small pieces ────────────────────────────────────────

const NEED_LABEL: Record<Need, string> = { required: 'Needed', recommended: 'Recommended', optional: 'Optional' };

const code = (text: string) => h('code', {}, text);
const p = (...c: Child[]) => h('p', {}, ...c);
const str = (path: string) => String(k.get(path) ?? '').trim();
const arr = (path: string): string[] => ((k.get(path) ?? []) as string[]).filter((x) => String(x).trim());
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ex = (win: string, other: string) => (k.isWindows ? win : other);

/**
 * One question: what it is, whether it is needed, what it does, what a value looks like, and
 * where to find it. `path` gets the error line the hub's checks write into.
 */
function q(o: {
  label: string;
  need: Need;
  path?: string;
  help: Child | Child[];
  control: HTMLElement;
  examples?: string[];
  /** Values found or worked out here, each filled in with one click. */
  suggest?: HTMLElement | null;
  tip?: { title: string; body: Child[] };
}): HTMLElement {
  const help = Array.isArray(o.help) ? o.help : [o.help];
  const target = o.control.matches('input, select') ? o.control : o.control.querySelector<HTMLElement>('input:not([type=checkbox]), select');
  const id = `gq-${Math.random().toString(36).slice(2, 9)}`;
  if (target) target.id ||= id;
  const label = target ? h('label', { for: target.id }, o.label) : h('span', {}, o.label);
  if (!target) o.control.setAttribute('aria-label', o.label);
  return h(
    'div',
    { class: 'gq' },
    h('div', { class: 'gq-head' }, label, h('span', { class: `need ${o.need}` }, NEED_LABEL[o.need])),
    h('div', { class: 'gq-help' }, ...help),
    h('div', { class: 'gq-control' }, o.control),
    o.path ? k.errorSlot(o.path) : null,
    o.suggest ?? null,
    o.examples?.length
      ? h('div', { class: 'gq-examples' }, h('span', { class: 'gq-ex-label' }, o.examples.length === 1 ? 'Looks like' : 'Looks like one of'), ...o.examples.map((e) => h('code', {}, e)))
      : null,
    o.tip ? h('details', { class: 'gq-tip' }, h('summary', {}, o.tip.title), h('div', {}, ...o.tip.body)) : null,
  );
}

/** "What you get" or a heads-up, beside the questions. */
function callout(kind: 'gain' | 'note' | 'warn', title: string, ...body: Child[]): HTMLElement {
  return h('div', { class: `g-callout ${kind}` }, h('div', { class: 'g-callout-title' }, title), ...body);
}

function bullets(...items: Child[]): HTMLElement {
  return h('ul', { class: 'g-bullets' }, ...items.map((i) => h('li', {}, i)));
}

/** Buttons that fill a value in; re-renders the step so every control shows it. */
function suggestions(label: string, items: { text: string; title?: string; apply: () => void; inUse?: boolean }[]): HTMLElement | null {
  if (!items.length) return null;
  return h(
    'div',
    { class: 'gq-suggest' },
    h('span', { class: 'gq-ex-label' }, label),
    ...items.map((it) => {
      const b = h('button', { type: 'button', class: `suggest${it.inUse ? ' on' : ''}`, title: it.inUse ? 'In use' : it.title ?? 'Use this' }, it.text) as HTMLButtonElement;
      b.disabled = !!it.inUse;
      b.addEventListener('click', () => {
        it.apply();
        renderStep();
      });
      return b;
    }),
  );
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A block of text to copy, such as lines for a config file. */
function snippet(text: string): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    } catch {
      /* clipboard blocked; the text can still be selected */
    }
  });
  return h('div', { class: 'g-snippet-box' }, h('pre', {}, text), btn);
}

/** A "find it for me" area: looks once (the hub scans the usual places), then shows `show`. */
function detected(show: (d: Detected) => HTMLElement | null): HTMLElement {
  const box = h('div', { class: 'g-detect' });
  const fill = (d: Detected | null) => box.replaceChildren(...(d ? [show(d)].filter((x): x is HTMLElement => !!x) : []));
  if (G.detected) fill(G.detected);
  else {
    box.append(h('div', { class: 'g-looking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Looking in the usual places…'));
    void detect().then((d) => box.isConnected && fill(d));
  }
  return box;
}

function detect(): Promise<Detected | null> {
  G.detecting ??= fetch('/api/setup/detect')
    .then((r) => (r.ok ? (r.json() as Promise<Detected>) : null))
    .catch(() => null)
    .then((d) => (G.detected = d));
  return G.detecting;
}

/** Saves now, for a "try it" button; shows what went wrong under `out`. */
async function saveForTry(out: HTMLElement): Promise<boolean> {
  out.replaceChildren(h('span', { class: 'pm muted' }, 'Saving…'));
  const r = await k.save();
  if (r.ok) {
    G.saved = true;
    G.errors = [];
    out.replaceChildren();
    renderRail();
    return true;
  }
  if ('errors' in r) {
    setErrors(r.errors);
    const here = r.errors.filter((e) => stepFor(e.path) === G.steps[G.index]);
    out.replaceChildren(h('span', { class: 'pm warn' }, here.length
      ? 'Something on this page needs fixing first: see the red text above.'
      : `Another step needs fixing first: ${[...new Set(r.errors.map((e) => stepFor(e.path)?.rail ?? e.path))].join(', ')}.`));
  } else out.replaceChildren(h('span', { class: 'pm warn' }, `Could not save: ${r.message}`));
  return false;
}

// ── Steps ───────────────────────────────────────────────

const TOPICS: { id: Topic; title: string; text: string; icon: string }[] = [
  { id: 'browser', title: 'A web app in Chrome', icon: '◎', text: 'See console errors and every network request your page makes, with what was sent and what came back.' },
  { id: 'tomcatLogs', title: 'Tomcat logs', icon: '≡', text: 'Follow your Java server’s log lines as they are written: errors, exceptions and full stack traces.' },
  { id: 'tomcatServer', title: 'Running Tomcat from here', icon: '▶', text: 'Start and stop Tomcat (and the rest of your dev setup), manage webapps, and deploy each new WAR build in one click.' },
  { id: 'editor', title: 'Jumping to the code', icon: '↗', text: 'Click a class name or a line of a stack trace and the file opens in your editor at that line.' },
  { id: 'postgres', title: 'Postgres', icon: '⛁', text: 'Slow queries, their query plans and database errors, next to the request that caused them.' },
  { id: 'api', title: 'REST APIs', icon: '{ }', text: 'Try your endpoints from their OpenAPI (Swagger) description, save requests, and replay ones the browser made.' },
];

/** What the settings already say about each topic, for the first page's ticks. */
function topicsFromSettings(): Set<Topic> {
  const t = new Set<Topic>();
  if (k.get('chrome.enabled')) t.add('browser');
  if (k.get('tomcat.enabled')) t.add('tomcatLogs');
  if (str('tomcat.webappsDir') || str('tomcat.startScript') || str('tomcat.home') || arr('tomcat.warWatch').length) t.add('tomcatServer');
  if (k.get('postgres.enabled')) t.add('postgres');
  if (str('editor.kind')) t.add('editor');
  if (((k.get('api.specs') ?? []) as unknown[]).length) t.add('api');
  return t;
}

function setTopic(t: Topic, on: boolean): void {
  if (on) G.topics.add(t);
  else G.topics.delete(t);
  // The three log sources are switched on and off with their topic; the rest only add steps.
  if (t === 'browser') k.set('chrome.enabled', on);
  if (t === 'tomcatLogs') k.set('tomcat.enabled', on);
  if (t === 'postgres') k.set('postgres.enabled', on);
  buildSteps();
  renderRail();
  renderFoot();
}

function welcomeStep(): Step {
  return {
    id: 'welcome',
    rail: 'Welcome',
    title: G.opts?.firstRun ? 'Welcome to Debug Hub' : 'Let’s set up Debug Hub',
    icon: '✦',
    paths: [],
    summary: () => (G.topics.size ? `${plural(G.topics.size, 'thing')} picked` : null),
    render: () => {
      const cards = TOPICS.map((t) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = G.topics.has(t.id);
        const card = h('label', { class: `topic${cb.checked ? ' on' : ''}` },
          cb,
          h('span', { class: 'topic-icon', 'aria-hidden': 'true' }, t.icon),
          h('span', { class: 'topic-text' }, h('strong', {}, t.title), h('span', {}, t.text)),
          h('span', { class: 'topic-check', 'aria-hidden': 'true' }, '✓'),
        );
        cb.addEventListener('change', () => {
          card.classList.toggle('on', cb.checked);
          setTopic(t.id, cb.checked);
        });
        return card;
      });
      return [
        p('Debug Hub puts everything that happens while you test your app on one timeline: what the browser did, what the server logged, and what the database ran. When something breaks, you see the whole story in one place.'),
        p('This guide asks about your setup one step at a time and explains each setting as it goes. ', h('strong', {}, 'Nothing is saved until the last step'), ', you can go back at any time, and anything you skip can be filled in later under Settings.'),
        h('h3', {}, 'What would you like Debug Hub to help with?'),
        p(h('span', { class: 'muted' }, 'Pick everything that applies. You only get the steps for what you pick.')),
        h('div', { class: 'topics' }, ...cards),
        callout('note', 'Good to have at hand', bullets(
          'Where Tomcat is installed, or the folder its logs are written to.',
          'The folder your project builds its WAR file into (often target).',
          'Which code editor you use.',
        ), p('Don’t worry if you don’t know some of these: the guide looks in the usual places for you and says where to find the rest.')),
      ];
    },
  };
}

function chromeStep(): Step {
  return {
    id: 'browser',
    rail: 'Chrome',
    title: 'Your browser',
    icon: '◎',
    paths: ['chrome'],
    when: (t) => t.has('browser'),
    summary: () => (k.get('chrome.enabled') ? `Port ${k.get('chrome.port')}` : null),
    render: () => {
      const parts = k.chromeParts();
      const port = k.numberInput('chrome.port', { min: 1, max: 65535 });
      const tryOut = h('div', { class: 'list-note' });
      const tryBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save and start Chrome') as HTMLButtonElement;
      const note = h('div', { class: 'g-chrome-note' });
      showChromeNote(note);
      tryBtn.addEventListener('click', async () => {
        tryBtn.disabled = true;
        if (await saveForTry(tryOut)) await startChrome();
        tryBtn.disabled = false;
      });
      return [
        p('Debug Hub watches a Chrome window through Chrome’s ', h('em', {}, 'remote debugging'), ' connection. Every console message, JavaScript error and network request in that window lands on the timeline, with the request and response bodies.'),
        callout('gain', 'Good to know',
          p('Debug Hub starts Chrome with a ', h('strong', {}, 'profile of its own'), ', so your everyday Chrome, with its tabs and sign-ins, is left alone. In that window you may need to sign in to your app once; it is remembered after that.')),
        q({
          label: 'Chrome program',
          need: 'optional',
          path: 'chrome.executable',
          help: 'Debug Hub finds Chrome by itself. Fill this in only if it says it couldn’t, or to use another Chromium browser such as Edge or Brave.',
          control: h('div', {}, k.fileInput('chrome.executable', 'Choose the Chrome program', 'Found automatically'), parts.exeNote),
          examples: [ex('C:/Program Files/Google/Chrome/Application/chrome.exe', k.isMac ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')],
        }),
        q({
          label: 'Profile folder',
          need: 'recommended',
          path: 'chrome.profileDir',
          help: [
            'Where this Chrome keeps its bookmarks, cookies and sign-ins, separate from your usual Chrome. Recent Chrome versions only allow debugging with a separate folder like this. ',
            'The default, ', code('chrome-profile'), ', is a folder next to Debug Hub’s settings file: fine for almost everyone.',
          ],
          control: h('div', {}, k.folderInput('chrome.profileDir', 'Choose Chrome’s profile folder'), parts.profileNote),
          suggest: str('chrome.profileDir') !== 'chrome-profile' ? suggestions('Default', [{ text: 'chrome-profile', apply: () => k.set('chrome.profileDir', 'chrome-profile') }]) : null,
        }),
        q({
          label: 'Debugging port',
          need: 'optional',
          path: 'chrome.port',
          help: ['The port Chrome and Debug Hub talk over. Keep ', code('9222'), ' unless another program already uses it.'],
          control: port,
          suggest: Number(k.get('chrome.port')) !== 9222 ? suggestions('Default', [{ text: '9222', apply: () => k.set('chrome.port', 9222) }]) : null,
        }),
        q({
          label: 'Record response bodies',
          need: 'recommended',
          path: 'chrome.captureBodies',
          help: 'Keeps what the server sent back (the JSON of an API call, for example), so you can read it on the timeline and in the JSON viewer. Turn it off if your app downloads a lot of large files.',
          control: h('div', { class: 'g-inline' }, k.toggle('chrome.captureBodies', 'Record response bodies'), h('span', {}, 'Record them')),
        }),
        q({
          label: 'Which kinds of response',
          need: 'optional',
          path: 'chrome.bodyResourceTypes',
          help: [h('strong', {}, 'XHR'), ' and ', h('strong', {}, 'Fetch'), ' are your app’s API calls: usually all you need. ', h('strong', {}, 'Document'), ' is the HTML page itself; scripts and stylesheets are rarely interesting.'],
          control: k.chipToggles('chrome.bodyResourceTypes', k.RESOURCE_TYPES),
        }),
        h('div', { class: 'g-try' },
          h('div', { class: 'g-try-text' }, h('strong', {}, 'Try it'), h('span', {}, 'Saves your answers so far and opens Chrome, connected to Debug Hub. Open your app in that window.')),
          h('div', {}, tryBtn, tryOut, note),
        ),
        q({
          label: 'Or start Chrome yourself',
          need: 'optional',
          help: 'Debug Hub has a Start Chrome button at the top of the window, so you rarely need this. For a desktop shortcut or a terminal, use this command:',
          control: parts.commands,
        }),
      ];
    },
  };
}

/** How the last Start Chrome went, under the Chrome step's button. */
function showChromeNote(into?: Element | null): void {
  const el = into ?? G.dialog?.querySelector('.g-chrome-note');
  el?.replaceChildren(...[chromeLaunchNote()].filter((x): x is HTMLElement => !!x));
}
const onChromeLaunch = () => showChromeNote();

function tomcatChoices(d: Detected, use: (t: TomcatFound) => void, what: (t: TomcatFound) => string | null, current: string): HTMLElement | null {
  const usable = d.tomcat.filter((t) => what(t));
  if (!usable.length) return h('div', { class: 'g-found none' }, 'No Tomcat found in the usual places. Use Browse… to pick the folder.');
  return h(
    'div',
    { class: 'g-found' },
    h('div', { class: 'g-found-title' }, usable.length === 1 ? 'Found on this computer' : `Found ${usable.length} on this computer`),
    ...usable.map((t) => {
      const inUse = !!current && samePath(current, what(t) ?? '');
      const b = h('button', { type: 'button', class: `g-found-item${inUse ? ' on' : ''}`, title: inUse ? 'In use' : 'Use this one' },
        h('span', { class: 'g-found-main' }, h('strong', {}, `Tomcat${t.version ? ` ${t.version}` : ''}`), h('span', { class: 'g-found-from' }, t.from)),
        h('code', {}, what(t) ?? ''),
        h('span', { class: 'g-found-use' }, inUse ? '✓ In use' : 'Use'),
      ) as HTMLButtonElement;
      b.addEventListener('click', () => {
        use(t);
        renderStep();
      });
      return b;
    }),
  );
}

function tomcatLogsStep(): Step {
  return {
    id: 'tomcatLogs',
    rail: 'Tomcat logs',
    title: 'Tomcat’s logs',
    icon: '≡',
    paths: ['tomcat.enabled', 'tomcat.logsDir', 'tomcat.appLogs', 'tomcat.accessLogs', 'tomcat.accessDurationUnit'],
    when: (t) => t.has('tomcatLogs'),
    summary: () => str('tomcat.logsDir') || (arr('tomcat.appLogs').length ? plural(arr('tomcat.appLogs').length, 'log file') : null),
    needs: () => (str('tomcat.logsDir') || arr('tomcat.appLogs').length || arr('tomcat.accessLogs').length ? null : 'No logs folder yet, so no Tomcat logs are followed'),
    render: () => [
      p('Tomcat writes what your application logs, and every request it serves, to files in its ', code('logs'), ' folder. Point Debug Hub at that folder and each new line shows up on the timeline as it is written, labelled with the webapp it came from.'),
      q({
        label: 'Logs folder',
        need: 'recommended',
        path: 'tomcat.logsDir',
        help: ['The ', code('logs'), ' folder of the Tomcat you run, next to its ', code('bin'), ', ', code('conf'), ' and ', code('webapps'), ' folders. Every log in it is followed, including new ones as they appear.'],
        control: k.logsFolderInput(),
        examples: [ex('C:/apache-tomcat-9.0.85/logs', '/opt/tomcat/logs')],
        suggest: detected((d) => tomcatChoices(d, (t) => {
          k.set('tomcat.logsDir', t.logs);
          if (t.major) k.set('tomcat.accessDurationUnit', t.major >= 10 ? 'us' : 'ms');
        }, (t) => t.logs, str('tomcat.logsDir'))),
        tip: {
          title: 'Running Tomcat from IntelliJ IDEA?',
          body: [
            p('IntelliJ runs Tomcat with a folder of its own for logs and settings, so the logs are not in the Tomcat install. Start your app in IntelliJ and look at the first lines of the Tomcat console for:'),
            h('pre', {}, ex('Using CATALINA_BASE:   "C:\\Users\\you\\AppData\\Local\\JetBrains\\IntelliJIdea2025.2\\tomcat\\5f1c…"', 'Using CATALINA_BASE:   "/home/you/.cache/JetBrains/IntelliJIdea2025.2/tomcat/5f1c…"')),
            p('The logs folder is the ', code('logs'), ' folder inside that one. If you have started it from IntelliJ before, it is probably in the list found above.'),
          ],
        },
      }),
      q({
        label: 'Which Tomcat version?',
        need: 'recommended',
        path: 'tomcat.accessDurationUnit',
        help: 'Tomcat 10 changed how request times are written to the access log, so Debug Hub needs to know which one you have to show response times correctly.',
        control: k.select('tomcat.accessDurationUnit', [
          ['ms', 'Tomcat 9 or earlier'],
          ['us', 'Tomcat 10 or later'],
          ['s', 'My access log pattern writes seconds'],
        ]),
        tip: { title: 'How do I tell?', body: [p('The version is usually in the folder name (', code('apache-tomcat-9.0.85'), ' is Tomcat 9), in the first lines Tomcat prints when it starts (', code('Server version name: Apache Tomcat/10.1.19'), '), or in the ', code('RELEASE-NOTES'), ' file in its folder.')] },
      }),
      h('details', { class: 'g-more' },
        h('summary', {}, 'Log files somewhere else? (optional)'),
        q({
          label: 'Extra application logs',
          need: 'optional',
          path: 'tomcat.appLogs',
          help: ['Only for logs outside the logs folder above, for example a log file your app writes to its own folder. Use ', code('*'), ' in the file name for files with a date in it, so tomorrow’s file is followed too.'],
          control: k.listEditor('tomcat.appLogs', { itemLabel: 'Application log', addLabel: 'Add log file', placeholder: ex('C:/myapp/logs/app-*.log', '/var/log/myapp/app-*.log'), empty: 'None.', browse: { kind: 'file', title: 'Choose a log file' }, match: true }),
        }),
        q({
          label: 'Extra access logs',
          need: 'optional',
          path: 'tomcat.accessLogs',
          help: ['Access logs outside the logs folder: one line per request, with its status and how long it took. Usually named ', code('localhost_access_log.<date>.txt'), '.'],
          control: k.listEditor('tomcat.accessLogs', { itemLabel: 'Access log', addLabel: 'Add access log', placeholder: ex('C:/tomcat/logs/localhost_access_log.*.txt', '/opt/tomcat/logs/localhost_access_log.*.txt'), empty: 'None.', browse: { kind: 'file', title: 'Choose an access log' }, match: true }),
        }),
      ),
    ],
  };
}

function tomcatServerStep(): Step {
  return {
    id: 'tomcatServer',
    rail: 'Tomcat server',
    title: 'Starting and stopping Tomcat',
    icon: '▶',
    paths: ['tomcat.webappsDir', 'tomcat.disabledDir', 'tomcat.home', 'tomcat.javaHome', 'tomcat.startScript', 'tomcat.stopScript', 'tomcat.startCommands', 'tomcat.startChrome', 'tomcat.manager'],
    when: (t) => t.has('tomcatServer'),
    summary: () => str('tomcat.webappsDir') || str('tomcat.startScript') || null,
    needs: () => (str('tomcat.webappsDir') ? null : 'No webapps folder yet, so the Tomcat page has nothing to show'),
    render: () => {
      const webapps = str('tomcat.webappsDir');
      const parent = webapps.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
      const password = k.textInput('tomcat.manager.password', { mono: true });
      password.type = 'password';
      return [
        p('The ', h('strong', {}, 'Tomcat page'), ' (the server button at the top) lists your webapps and lets you start and stop Tomcat, switch single webapps off and on, and deploy new builds. For that, Debug Hub needs to know where Tomcat is.'),
        q({
          label: 'Webapps folder',
          need: 'required',
          path: 'tomcat.webappsDir',
          help: ['The folder Tomcat deploys from, where your ', code('.war'), ' files and webapp folders live.'],
          control: k.folderInput('tomcat.webappsDir', 'Choose Tomcat’s webapps folder'),
          examples: [ex('C:/apache-tomcat-9.0.85/webapps', '/opt/tomcat/webapps')],
          suggest: detected((d) => tomcatChoices(d, (t) => {
            k.set('tomcat.webappsDir', t.webapps);
            if (t.home && t.home !== t.base) k.set('tomcat.home', t.home);
          }, (t) => t.webapps, str('tomcat.webappsDir'))),
        }),
        q({
          label: 'Tomcat folder',
          need: 'optional',
          path: 'tomcat.home',
          help: ['Where Tomcat itself is installed (', code('CATALINA_HOME'), '), with its ', code('bin'), ' folder. Leave it empty when it is the folder above webapps, as it usually is.'],
          control: k.tomcatHomeInput(),
          examples: [ex('C:/apache-tomcat-9.0.85', '/opt/tomcat')],
        }),
        q({
          label: 'Java folder',
          need: 'optional',
          path: 'tomcat.javaHome',
          help: ['The Java Tomcat runs on (', code('JAVA_HOME'), '). Leave it empty if Tomcat already starts fine from a terminal; fill it in if starting Tomcat says Java was not found.'],
          control: k.folderInput('tomcat.javaHome', 'Choose the Java folder (a JDK)'),
          examples: [ex('C:/Program Files/Eclipse Adoptium/jdk-17.0.10.7-hotspot', '/usr/lib/jvm/java-17-openjdk')],
          suggest: detected((d) => d.javaHomes.length
            ? suggestions('Found', d.javaHomes.slice(0, 6).map((j) => ({
                text: `${j.version ? `Java ${j.version} · ` : ''}${j.dir.split('/').pop()}`,
                title: `${j.dir} (${j.from})`,
                inUse: samePath(str('tomcat.javaHome'), j.dir),
                apply: () => k.set('tomcat.javaHome', j.dir),
              })))
            : null),
        }),
        q({
          label: 'Folder for switched-off webapps',
          need: 'optional',
          path: 'tomcat.disabledDir',
          help: 'When you switch a webapp off on the Tomcat page, it is moved here so Tomcat stops loading it, and moved back when you switch it on. Pick any folder outside webapps.',
          control: k.folderInput('tomcat.disabledDir', 'Choose a folder for switched-off webapps'),
          suggest: parent && !str('tomcat.disabledDir') ? suggestions('Suggested', [{ text: `${parent}/webapps-disabled`, apply: () => k.set('tomcat.disabledDir', `${parent}/webapps-disabled`) }]) : null,
        }),
        q({
          label: 'Also open Chrome',
          need: 'optional',
          path: 'tomcat.startChrome',
          help: 'When you press Start Tomcat, open the debugging Chrome too, so one click gets you ready to test.',
          control: h('div', { class: 'g-inline' }, k.toggle('tomcat.startChrome', 'Also open Chrome'), h('span', {}, 'Open Chrome after Tomcat starts')),
        }),
        h('details', { class: 'g-more' },
          h('summary', {}, 'Start the rest of your dev setup too (optional)'),
          p('Start Tomcat can first run other commands you need, in order: a database, a message queue, your front end’s dev server… Their output shows on the timeline.'),
          q({
            label: 'Commands to run first',
            need: 'optional',
            path: 'tomcat.startCommands',
            help: ['Tick ', h('strong', {}, 'Wait'), ' for something Tomcat needs finished first, like starting a database (', code(ex('net start postgresql-x64-16', 'pg_ctl start -D /usr/local/var/postgres')), '). Leave it off for things that keep running, like ', code('npm run dev'), '.'],
            control: k.startCommandsEditor(),
          }),
        ),
        h('details', { class: 'g-more' },
          h('summary', {}, 'Do you start Tomcat with a script of your own? (optional)'),
          q({
            label: 'Start script',
            need: 'optional',
            path: 'tomcat.startScript',
            help: ['Normally Start Tomcat runs Tomcat’s own ', code(ex('bin\\catalina.bat run', 'bin/catalina.sh run')), ', with its output in the console on the Tomcat page. If your team starts it with a script of its own, choose that script here.'],
            control: k.fileInput('tomcat.startScript', 'Choose the script that starts Tomcat', 'Tomcat’s own startup'),
          }),
          q({
            label: 'Stop script',
            need: 'optional',
            path: 'tomcat.stopScript',
            help: 'The matching script that stops it.',
            control: k.fileInput('tomcat.stopScript', 'Choose the script that stops Tomcat', 'Tomcat’s own shutdown'),
          }),
        ),
        h('details', { class: 'g-more' },
          h('summary', {}, 'Tomcat Manager (optional, for reloading single webapps)'),
          p('With the Manager, a single webapp can be stopped, started and reloaded without restarting Tomcat. Without it, everything still works: switching a webapp off moves it out of webapps instead.'),
          q({ label: 'Manager URL', need: 'optional', path: 'tomcat.manager.url', help: ['Its text interface, ending in ', code('/manager/text'), '.'], control: k.textInput('tomcat.manager.url', { mono: true, placeholder: 'http://localhost:8080/manager/text' }), examples: ['http://localhost:8080/manager/text'] }),
          q({ label: 'Manager user', need: 'optional', path: 'tomcat.manager.username', help: ['A user with the ', code('manager-script'), ' role, set up in Tomcat’s ', code('conf/tomcat-users.xml'), ':'], control: k.textInput('tomcat.manager.username', { mono: true }) }),
          h('pre', { class: 'g-snippet' }, '<role rolename="manager-script"/>\n<user username="debughub" password="choose-one" roles="manager-script"/>'),
          q({ label: 'Manager password', need: 'optional', path: 'tomcat.manager.password', help: 'Kept in Debug Hub’s settings file as plain text, so use a password just for this.', control: password }),
        ),
      ];
    },
  };
}

function deployStep(): Step {
  return {
    id: 'deploy',
    rail: 'Deploying builds',
    title: 'Deploying your builds',
    icon: '⇪',
    paths: ['tomcat.warWatch', 'tomcat.preserveFiles'],
    when: (t) => t.has('tomcatServer'),
    summary: () => (arr('tomcat.warWatch').length ? plural(arr('tomcat.warWatch').length, 'build folder') : null),
    render: () => [
      p('When you build your project, a ', code('.war'), ' file appears in its build folder. Debug Hub can watch that folder and offer to deploy each new build to Tomcat with one click, keeping your local settings files.'),
      q({
        label: 'Build folders to watch',
        need: 'recommended',
        path: 'tomcat.warWatch',
        help: [
          'The folder your build writes the WAR into: ', code('target'), ' for Maven, ', code('build/libs'), ' for Gradle. Add one per project; ', code('*'), ' covers several at once. ',
          'These folders also tell Debug Hub where your source code is, for jumping to the code.',
        ],
        control: k.listEditor('tomcat.warWatch', { itemLabel: 'Build folder', addLabel: 'Add folder', placeholder: ex('C:/dev/shop/target', '/home/me/dev/shop/target'), empty: 'No folders yet.', browse: { kind: 'folder', title: 'Choose a folder where WARs are built' } }),
        examples: [ex('C:/dev/shop/target', '~/dev/shop/target'), ex('C:/dev/*/target', '~/dev/*/target')],
        suggest: detected((d) => {
          if (!d.warFolders.length) return h('div', { class: 'g-found none' }, 'No built WAR files found in the usual project folders. Build your project once, or use Add folder.');
          return suggestions('Found WARs in', d.warFolders.slice(0, 8).map((w) => ({
            text: w.dir,
            title: w.wars.join(', '),
            inUse: arr('tomcat.warWatch').some((x) => samePath(x, w.dir)),
            apply: () => k.set('tomcat.warWatch', [...arr('tomcat.warWatch'), w.dir]),
          })));
        }),
      }),
      q({
        label: 'Files to keep when deploying',
        need: 'optional',
        path: 'tomcat.preserveFiles',
        help: ['A new build replaces everything in the webapp. Files named here are offered to be kept from the deployed copy instead, such as configuration you edited by hand on this machine. ', code('*'), ' is allowed.'],
        control: k.listEditor('tomcat.preserveFiles', { itemLabel: 'File name', addLabel: 'Add file name', placeholder: 'application-local.properties', empty: 'None: a deploy always uses the files in the new build.', check: (n) => (/[\\/]/.test(n) ? 'A file name only, without a folder' : null) }),
        examples: ['config.yaml', 'log4j2.xml', '*.properties'],
      }),
    ],
  };
}

const EDITOR_INFO: Record<string, { name: string; text: string }> = {
  vscode: { name: 'VS Code', text: 'Opens in the VS Code window you have open.' },
  idea: { name: 'IntelliJ IDEA', text: 'Opens in IntelliJ, in the project it belongs to.' },
  nvim: { name: 'Neovim', text: 'In an nvim you have running, or a new terminal window.' },
  emacs: { name: 'Emacs', text: 'Through emacsclient, in Emacs or Doom Emacs.' },
  custom: { name: 'Something else', text: 'Any editor you can start with a command.' },
  '': { name: 'No editor', text: 'Turn jumping to the code off.' },
};

function editorStep(): Step {
  return {
    id: 'editor',
    rail: 'Editor',
    title: 'Jumping to the code',
    icon: '↗',
    paths: ['editor'],
    when: (t) => t.has('editor'),
    summary: () => (str('editor.kind') ? EDITOR_INFO[str('editor.kind')]?.name ?? str('editor.kind') : null),
    needs: () => (!str('editor.kind') ? 'No editor chosen yet' : str('editor.kind') === 'custom' && !str('editor.custom') ? 'The command for your editor is missing' : null),
    render: () => {
      const kind = str('editor.kind');
      const cards = k.EDITORS.map(([value]) => {
        const info = EDITOR_INFO[value];
        const b = h('button', { type: 'button', class: `editor-card${kind === value ? ' on' : ''}`, 'aria-pressed': String(kind === value) },
          h('strong', {}, info.name), h('span', {}, info.text));
        b.addEventListener('click', () => {
          k.set('editor.kind', value);
          renderStep();
        });
        return b;
      });
      const out: Child[] = [
        p('Class names and stack-trace lines in your logs become links. Click one (or press ', h('kbd', {}, 'G'), ') and the file opens in your editor, at that line.'),
        h('h3', {}, 'Which editor do you use?'),
        h('div', { class: 'editor-cards', role: 'group', 'aria-label': 'Editor' }, ...cards),
        k.errorSlot('editor.kind'),
      ];
      if (kind && kind !== 'custom') {
        out.push(q({
          label: 'Editor program',
          need: 'optional',
          path: 'editor.program',
          help: 'Debug Hub looks for it where it is usually installed. Fill this in only if it says it could not find it.',
          control: k.editorProgramInput(),
          examples: kind === 'vscode' ? [ex('C:/Users/you/AppData/Local/Programs/Microsoft VS Code/Code.exe', '/usr/bin/code')]
            : kind === 'idea' ? [ex('C:/Program Files/JetBrains/IntelliJ IDEA 2025.2/bin/idea64.exe', '/opt/idea/bin/idea.sh')]
              : kind === 'nvim' ? [ex('C:/Program Files/Neovim/bin/nvim.exe', '/usr/bin/nvim')] : [ex('C:/Program Files/Emacs/bin/emacsclient.exe', '/usr/bin/emacsclient')],
        }));
      }
      if (kind === 'emacs') out.push(callout('note', 'One thing to do in Emacs', p('Emacs only accepts files from outside while its server runs: run ', code('M-x server-start'), ', or add ', code('(server-start)'), ' to your config. Doom Emacs runs it already.')));
      if (kind === 'nvim') {
        out.push(
          q({
            label: 'Use an nvim that is already open',
            need: 'recommended',
            path: 'editor.nvimReuse',
            help: 'Opens the file in an nvim you have running (version 0.9 or later), preferring one working in that project. It can’t bring that terminal window to the front, so switch to it yourself.',
            control: h('div', { class: 'g-inline' }, k.toggle('editor.nvimReuse', 'Use a running nvim'), h('span', {}, 'Use a running nvim when there is one')),
          }),
          q({
            label: 'Terminal for a new window',
            need: 'recommended',
            path: 'editor.terminal',
            help: ['When no nvim is running, nvim starts in a new window of this terminal. Pick yours from the list; ', code('{cmd}'), ' stands for the nvim command and ', code('{dir}'), ' for the project folder.'],
            control: k.terminalInput(),
            tip: { title: 'Start it through your own shell (nushell, zsh…)', body: [p('So your shell’s settings apply, run nvim through it, e.g.:'), h('pre', {}, 'wezterm start -- nu -c "nvim +{line} {file}"')] },
          }),
        );
      }
      if (kind === 'custom') {
        out.push(q({
          label: 'Command',
          need: 'required',
          path: 'editor.custom',
          help: ['The command that opens a file at a line. ', code('{file}'), ', ', code('{line}'), ' and ', code('{column}'), ' are filled in; put quotes around a program path with spaces.'],
          control: k.textInput('editor.custom', { mono: true, placeholder: ex('"C:/Program Files/Sublime Text/subl.exe" {file}:{line}:{column}', 'subl {file}:{line}:{column}') }),
          examples: [ex('"C:/Program Files/Sublime Text/subl.exe" {file}:{line}', 'subl {file}:{line}'), 'zed {file}:{line}'],
        }));
      }
      if (kind) {
        out.push(q({
          label: 'More project folders',
          need: 'optional',
          path: 'editor.sourceDirs',
          help: [
            'Debug Hub finds your code from the build folders of the last step. Add projects it can’t find that way, such as a shared library you also work on: its whole folder, the one with ', code('pom.xml'), ' or ', code('build.gradle'), '.',
          ],
          control: k.listEditor('editor.sourceDirs', { itemLabel: 'Project folder', addLabel: 'Add folder', placeholder: ex('C:/dev/common-lib', '/home/me/dev/common-lib'), empty: 'None.', browse: { kind: 'folder', title: 'Choose a project folder' } }),
        }));
        const tryOut = h('div', { class: 'list-note' });
        const tryBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save and open a file') as HTMLButtonElement;
        tryBtn.addEventListener('click', async () => {
          tryBtn.disabled = true;
          try {
            if (!(await saveForTry(tryOut))) return;
            tryOut.replaceChildren(h('span', { class: 'pm muted' }, 'Opening…'));
            const res = await fetch('/api/source/test', { method: 'POST' });
            const body = await res.json();
            tryOut.replaceChildren(res.ok ? h('span', { class: 'pm ok' }, body.message) : h('span', { class: 'pm warn' }, [body.error, body.hint].filter(Boolean).join(' ')));
          } catch (err) {
            tryOut.replaceChildren(h('span', { class: 'pm warn' }, (err as Error).message));
          } finally {
            tryBtn.disabled = false;
          }
        });
        out.push(h('div', { class: 'g-try' },
          h('div', { class: 'g-try-text' }, h('strong', {}, 'Try it'), h('span', {}, 'Saves your answers so far and opens one of your classes in the editor. It needs at least one project found from your build folders.')),
          h('div', {}, tryBtn, tryOut),
        ));
      }
      return out;
    },
  };
}

function postgresStep(): Step {
  const conf = [
    "# In postgresql.conf, then restart Postgres:",
    "log_min_duration_statement = 200   # log queries slower than 200 ms",
    "logging_collector = on",
    "log_directory = 'log'",
    "log_filename = 'postgresql-%Y-%m-%d.log'",
    "",
    "# Optional: also log each slow query's plan",
    "shared_preload_libraries = 'auto_explain'",
    "auto_explain.log_min_duration = 200",
  ].join('\n');
  return {
    id: 'postgres',
    rail: 'Postgres',
    title: 'Postgres',
    icon: '⛁',
    paths: ['postgres'],
    when: (t) => t.has('postgres'),
    summary: () => (arr('postgres.logs').length ? plural(arr('postgres.logs').length, 'log') : null),
    needs: () => (arr('postgres.logs').length ? null : 'No log file yet, so nothing from Postgres is shown'),
    render: () => [
      p('Postgres can write slow queries, their query plans, and errors to its server log. Debug Hub follows that log and shows each one beside the request that caused it.'),
      q({
        label: 'Server log files',
        need: 'required',
        path: 'postgres.logs',
        help: ['Usually the ', code('log'), ' folder inside the Postgres data folder. Use ', code('*'), ' in the file name, because Postgres starts a new file every day.'],
        control: k.listEditor('postgres.logs', { itemLabel: 'Postgres log', addLabel: 'Add log file', placeholder: ex('C:/Program Files/PostgreSQL/16/data/log/postgresql-*.log', '/var/lib/postgresql/16/main/log/postgresql-*.log'), empty: 'No logs yet.', browse: { kind: 'file', title: 'Choose a Postgres server log' }, match: true }),
        examples: [ex('C:/Program Files/PostgreSQL/16/data/log/postgresql-*.log', k.isMac ? '/opt/homebrew/var/log/postgresql@16.log' : '/var/log/postgresql/postgresql-16-main.log')],
        suggest: detected((d) => {
          if (!d.postgresLogs.length) return h('div', { class: 'g-found none' }, 'No Postgres logs found in the usual places. Use Add log file to pick one.');
          return h('div', {},
            suggestions('Found', d.postgresLogs.filter((l) => !l.note).map((l) => ({
              text: l.pattern,
              title: l.version ? `Postgres ${l.version}` : undefined,
              inUse: arr('postgres.logs').some((x) => samePath(x, l.pattern)),
              apply: () => k.set('postgres.logs', [...arr('postgres.logs'), l.pattern]),
            }))) ?? '',
            ...d.postgresLogs.filter((l) => l.note).map((l) => h('div', { class: 'g-found none' }, h('code', {}, l.dir), ' ', l.note)),
          );
        }),
      }),
      callout('note', 'Seeing no slow queries?',
        p('By default Postgres doesn’t log them. Add these lines to ', code('postgresql.conf'), ' (in the data folder) and restart Postgres. 200 ms is a good start; lower it to see more.'),
        snippet(conf),
      ),
    ],
  };
}

function apiStep(): Step {
  return {
    id: 'api',
    rail: 'REST APIs',
    title: 'Trying your REST APIs',
    icon: '{ }',
    paths: ['api'],
    when: (t) => t.has('api'),
    summary: () => {
      const n = ((k.get('api.specs') ?? []) as { url?: string }[]).filter((s) => s.url?.trim()).length;
      return n ? plural(n, 'spec') : null;
    },
    render: () => [
      p('The ', h('strong', {}, 'API screen'), ' sends requests to your endpoints and shows the answers on the timeline. With your API’s ', h('em', {}, 'OpenAPI'), ' (or Swagger) description, it lists every endpoint with its parameters, so you just fill in the blanks.'),
      q({
        label: 'API descriptions (specs)',
        need: 'recommended',
        path: 'api.specs',
        help: [
          'A name you choose, and the address of the description. Spring Boot apps with ', h('em', {}, 'springdoc'), ' serve it at ', code('/v3/api-docs'), ', older ones with ', h('em', {}, 'springfox'), ' at ', code('/v2/api-docs'), '. A JSON or YAML file works too.',
        ],
        control: k.rowsEditor('api.specs', [
          { key: 'name', label: 'Name', placeholder: 'Shop', width: '0 0 150px' },
          { key: 'url', label: 'URL or file', placeholder: 'http://localhost:8080/shop/v3/api-docs', mono: true },
        ], { addLabel: 'Add spec', empty: 'None yet. You can still type requests by hand.', itemLabel: 'Spec' }),
        examples: ['http://localhost:8080/shop/v3/api-docs', 'http://localhost:8080/shop/v2/api-docs'],
        tip: { title: 'How do I find it?', body: [p('If your app has a Swagger UI page (often ', code('/swagger-ui.html'), ' or ', code('/swagger-ui/index.html'), '), open it: the link to the description is near the top, usually ending in ', code('api-docs'), '.')] },
      }),
      q({
        label: 'Base URL',
        need: 'optional',
        path: 'api.baseUrl',
        help: 'Where requests go. Leave it empty to use the server the description names; fill it in when that one is wrong for your machine.',
        control: k.textInput('api.baseUrl', { mono: true, placeholder: 'From the spec’s servers' }),
        examples: ['http://localhost:8080/shop'],
      }),
      q({
        label: 'Headers for every request',
        need: 'optional',
        path: 'api.headers',
        help: 'Sent with each request, for example a login token. Kept in the settings file as plain text.',
        control: k.rowsEditor('api.headers', [
          { key: 'name', label: 'Header', placeholder: 'Authorization', mono: true, width: '0 0 190px' },
          { key: 'value', label: 'Value', placeholder: 'Bearer eyJhbGciOi…', mono: true },
        ], { addLabel: 'Add header', empty: 'None.', itemLabel: 'Header' }),
      }),
      q({
        label: 'Accept self-signed certificates',
        need: 'optional',
        path: 'api.insecureTls',
        help: ['Turn on if your local server uses ', code('https'), ' with a certificate your computer doesn’t trust, as dev servers often do. Leave off otherwise.'],
        control: h('div', { class: 'g-inline' }, k.toggle('api.insecureTls', 'Accept self-signed certificates'), h('span', {}, 'Accept them')),
      }),
    ],
  };
}

function matchingStep(): Step {
  return {
    id: 'matching',
    rail: 'Linking requests',
    title: 'Linking requests to log lines',
    icon: '⇄',
    paths: ['correlation', 'api.addRequestId'],
    when: (t) => (t.has('browser') || t.has('api')) && (t.has('tomcatLogs') || t.has('postgres')),
    summary: () => (arr('correlation.logPatterns').length ? plural(arr('correlation.logPatterns').length, 'pattern') : null),
    render: () => [
      p('Debug Hub can show, for each browser request, exactly the log lines and queries it caused. That works best when your app gives each request an ID and writes it in its log lines. ', h('strong', {}, 'This step is optional:'), ' without it, lines are matched by time, which is often good enough.'),
      q({
        label: 'Request ID header',
        need: 'optional',
        path: 'correlation.header',
        help: 'The HTTP header that carries the ID from the browser to your server, if your app uses one.',
        control: k.textInput('correlation.header', { mono: true, placeholder: 'X-Request-Id' }),
        examples: ['X-Request-Id', 'X-Correlation-Id'],
      }),
      q({
        label: 'How the ID appears in log lines',
        need: 'optional',
        path: 'correlation.logPatterns',
        help: ['A pattern (a regular expression) that finds the ID in a log line, with the ID in brackets. If your log lines contain ', code('requestId=7f3a9c21'), ', the pattern is ', code('requestId=([A-Za-z0-9-]+)'), '. Paste a real line below to check it.'],
        control: k.listEditor('correlation.logPatterns', { itemLabel: 'Pattern', addLabel: 'Add pattern', placeholder: 'requestId=([A-Za-z0-9-]+)', empty: 'None: lines are matched by time only.', check: (s) => { try { new RegExp(s); return null; } catch (err) { return (err as Error).message.replace(/^Invalid regular expression: /, ''); } } }),
        suggest: suggestions('Common', [
          { text: 'requestId=([A-Za-z0-9-]+)', apply: () => k.set('correlation.logPatterns', [...arr('correlation.logPatterns'), 'requestId=([A-Za-z0-9-]+)']) },
          { text: '\\[rid=([A-Za-z0-9-]+)\\]', apply: () => k.set('correlation.logPatterns', [...arr('correlation.logPatterns'), '\\[rid=([A-Za-z0-9-]+)\\]']) },
        ].filter((s) => !arr('correlation.logPatterns').includes(s.text))),
      }),
      q({ label: 'Try a log line', need: 'optional', help: 'Paste a line from your logs: it says which ID the patterns find.', control: k.patternTester() }),
      q({
        label: 'Add an ID to API screen requests',
        need: 'optional',
        path: 'api.addRequestId',
        help: 'Requests sent from the API screen get a fresh ID in the header above, so their log lines are linked too.',
        control: h('div', { class: 'g-inline' }, k.toggle('api.addRequestId', 'Add a request ID'), h('span', {}, 'Add one')),
      }),
    ],
  };
}

function privacyStep(): Step {
  return {
    id: 'privacy',
    rail: 'Recordings',
    title: 'Recordings and privacy',
    icon: '◐',
    paths: ['sessionsDir', 'redact', 'maxBodyBytes'],
    summary: () => str('sessionsDir') || null,
    render: () => [
      p('Debug Hub records each session to a file, so you can open it again later or send it to a colleague. Here you choose where those files go and what is kept out of them.'),
      q({
        label: 'Where recordings are saved',
        need: 'optional',
        path: 'sessionsDir',
        help: ['A folder for the session files. The default, ', code('sessions'), ', is next to Debug Hub’s settings file.'],
        control: k.folderInput('sessionsDir', 'Choose where sessions are saved'),
      }),
      q({
        label: 'Headers to hide',
        need: 'recommended',
        path: 'redact.headers',
        help: ['The values of these headers are replaced with ', code('[redacted]'), ' before anything is written, so passwords and tokens don’t end up in recordings. The usual ones are already listed; add any your app uses.'],
        control: k.listEditor('redact.headers', { itemLabel: 'Header', addLabel: 'Add header', placeholder: 'x-api-key', empty: 'None: every header is recorded as it is.' }),
        examples: ['authorization', 'cookie', 'x-api-key'],
      }),
      q({
        label: 'Largest body to keep',
        need: 'optional',
        path: 'maxBodyBytes',
        help: 'Request and response bodies longer than this are cut off, so big downloads don’t fill your disk. The event still says the full size.',
        control: k.numberInput('maxBodyBytes', { min: 0, max: 64 * 1024 * 1024, unit: 'kB', scale: 1024 }),
      }),
    ],
  };
}

function finishStep(): Step {
  return {
    id: 'finish',
    rail: 'Review and save',
    title: G.saved && !k.dirty() ? 'You’re all set' : 'Review and save',
    icon: '✓',
    paths: [],
    render: () => {
      const rows = G.steps.filter((s) => s.id !== 'welcome' && s.id !== 'finish').map((s) => {
        const sum = s.summary?.() ?? null;
        const need = s.needs?.() ?? null;
        const errs = errorsFor(s).length;
        const state = errs ? 'bad' : need ? 'warn' : sum ? 'ok' : 'skip';
        const go = h('button', { type: 'button', class: 'btn btn-sm' }, errs ? 'Fix' : need ? 'Finish' : 'Change');
        go.addEventListener('click', () => goTo(G.steps.indexOf(s)));
        return h('div', { class: `g-review-row ${state}` },
          h('span', { class: `g-review-dot ${state}`, 'aria-hidden': 'true' }, errs || need ? '!' : sum ? '✓' : '–'),
          h('span', { class: 'g-review-name' }, s.rail),
          h('span', { class: 'g-review-sum', title: sum ?? '' }, errs ? `${plural(errs, 'answer needs', 'answers need')} fixing` : need ?? sum ?? 'Skipped: fill it in later under Settings'),
          go,
        );
      });
      const unplaced = G.errors.filter((e) => !stepFor(e.path));
      const out: Child[] = [];
      if (G.saved && !k.dirty()) {
        out.push(
          h('div', { class: 'g-done' }, h('div', { class: 'g-done-icon', 'aria-hidden': 'true' }, '✓'),
            h('div', {}, h('strong', {}, 'Saved. Debug Hub is using your settings now.'), h('span', {}, 'Change anything later under Settings, or open this guide again from there.'))),
          h('h3', {}, 'Next'),
          bullets(
            ...(G.topics.has('browser') ? [h('span', {}, h('strong', {}, 'Start Chrome'), ' with the button at the top, and open your app in that window.')] : []),
            ...(G.topics.has('tomcatServer') ? [h('span', {}, 'Open the ', h('strong', {}, 'Tomcat page'), ' (the server button at the top) to start Tomcat and see your webapps.')] : []),
            ...(G.topics.has('tomcatLogs') ? ['Use your app: Tomcat’s log lines appear on the timeline as they are written.'] : []),
            ...(G.topics.has('api') ? [h('span', {}, 'Open the ', h('strong', {}, 'API screen'), ' to try your endpoints.')] : []),
            h('span', {}, 'Press ', h('kbd', {}, '?'), ' on the timeline for keyboard shortcuts.'),
          ),
        );
      } else {
        out.push(p('Here is what you filled in. Nothing is saved yet: press ', h('strong', {}, 'Save and finish'), ' to start using it. You can change any of it later under Settings.'));
        const unfinished = G.steps.filter((s) => s.needs?.()).length;
        if (unfinished && !G.errors.length) out.push(callout('note', unfinished === 1 ? 'One step isn’t finished' : `${unfinished} steps aren’t finished`, p('You can still save: those parts just stay off until they are filled in. Or press Finish to complete them now.')));
        if (G.errors.length) out.push(callout('warn', 'A few answers need another look', p('Debug Hub checked your answers and found something to fix. The red marks below take you to it.'), ...unplaced.map((e) => p(h('code', {}, e.path), ': ', e.message))));
      }
      out.push(h('div', { class: 'g-review' }, ...rows));
      out.push(p(h('span', { class: 'muted' }, 'A few rarely needed options (the hub’s own port, how often logs are checked, how updates are fetched) are under Settings › Advanced.')));
      return out;
    },
  };
}

function buildSteps(): void {
  const current = G.steps[G.index]?.id;
  const all = [welcomeStep(), chromeStep(), tomcatLogsStep(), tomcatServerStep(), deployStep(), editorStep(), postgresStep(), apiStep(), matchingStep(), privacyStep(), finishStep()];
  G.steps = all.filter((s) => !s.when || s.when(G.topics));
  const i = G.steps.findIndex((s) => s.id === current);
  G.index = i >= 0 ? i : Math.min(G.index, G.steps.length - 1);
}

// ── Errors ──────────────────────────────────────────────

function stepFor(path: string): Step | undefined {
  return G.steps.find((s) => s.paths.some((p) => path === p || path.startsWith(`${p}.`)));
}
const errorsFor = (s: Step) => G.errors.filter((e) => stepFor(e.path) === s);

function setErrors(errors: FieldError[]): void {
  G.errors = errors;
  k.placeErrors(errors);
  renderRail();
}

// ── Frame ───────────────────────────────────────────────

function renderRail(): void {
  const rail = G.dialog?.querySelector('.guide-rail');
  if (!rail) return;
  rail.replaceChildren(
    ...G.steps.map((s, i) => {
      const errs = errorsFor(s).length;
      const seen = G.visited.has(s.id) && i !== G.index;
      const state = i === G.index ? 'current' : errs ? 'bad' : seen && s.needs?.() ? 'warn' : seen && (s.summary?.() ?? null) !== null ? 'done' : seen ? 'seen' : 'todo';
      const b = h('button', { type: 'button', class: `rail-step ${state}`, 'aria-current': i === G.index ? 'step' : null },
        h('span', { class: 'rail-num', 'aria-hidden': 'true' }, errs || state === 'warn' ? '!' : state === 'done' ? '✓' : String(i + 1)),
        h('span', { class: 'rail-name' }, s.rail),
      );
      b.addEventListener('click', () => goTo(i));
      return b;
    }),
  );
}

function renderFoot(): void {
  const foot = G.dialog?.querySelector('.guide-foot');
  if (!foot) return;
  const last = G.index === G.steps.length - 1;
  const done = last && G.saved && !k.dirty();
  const back = h('button', { type: 'button', class: 'btn' }, '← Back') as HTMLButtonElement;
  back.disabled = G.index === 0;
  back.addEventListener('click', () => goTo(G.index - 1));
  const next = h('button', { type: 'button', class: 'btn btn-primary g-next' },
    done ? 'Close' : last ? 'Save and finish' : G.index === 0 ? 'Let’s go →' : G.index === G.steps.length - 2 ? 'Review →' : 'Next →') as HTMLButtonElement;
  next.addEventListener('click', () => {
    if (done) close();
    else if (last) void finish(next);
    else goTo(G.index + 1);
  });
  const pct = Math.round((G.index / Math.max(1, G.steps.length - 1)) * 100);
  foot.replaceChildren(
    back,
    h('div', { class: 'guide-progress' },
      h('div', { class: 'guide-progress-text' }, `Step ${G.index + 1} of ${G.steps.length}`),
      h('div', { class: 'guide-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, (() => {
        const fill = h('div', { class: 'guide-progress-fill' });
        fill.style.width = `${pct}%`;
        return fill;
      })()),
    ),
    next,
  );
}

function renderStep(): void {
  const main = G.dialog?.querySelector<HTMLElement>('.guide-main');
  if (!main) return;
  const step = G.steps[G.index];
  const again = main.dataset.step === step.id;
  const top = main.scrollTop;
  main.dataset.step = step.id;
  G.visited.add(step.id);
  k.beginPage();
  const body = step.render();
  const head = h('header', { class: 'guide-head' },
    h('div', { class: 'guide-icon', 'aria-hidden': 'true' }, step.icon),
    h('div', {}, h('div', { class: 'guide-kicker' }, step.id === 'welcome' ? 'Setup guide' : `Step ${G.index + 1} of ${G.steps.length}`), h('h2', { tabindex: '-1' }, step.title)),
  );
  const page = h('div', { class: 'guide-page' }, head, ...body);
  main.replaceChildren(page);
  if (again) main.scrollTop = top;
  k.placeErrors(G.errors);
  renderRail();
  renderFoot();
}

function goTo(i: number): void {
  if (i < 0 || i >= G.steps.length) return;
  // The finish page reflects the answers given since it was built.
  if (G.steps[i].id === 'finish') G.steps[i] = finishStep();
  G.index = i;
  renderStep();
  const main = G.dialog?.querySelector<HTMLElement>('.guide-main');
  main?.scrollTo({ top: 0 });
  main?.querySelector<HTMLElement>('.guide-head h2')?.focus({ preventScroll: true });
  const first = main?.querySelector<HTMLElement>('.gq-control input:not([type=checkbox]), .topic input');
  if (G.index > 0) first?.focus({ preventScroll: true });
}

async function finish(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const r = await k.save();
  btn.disabled = false;
  if (r.ok) {
    G.saved = true;
    G.errors = [];
  } else if ('errors' in r) {
    G.errors = r.errors;
  } else {
    G.errors = [{ path: '', message: `Could not save: ${r.message}` }];
  }
  G.steps[G.index] = finishStep();
  renderStep();
}

/** Closing: answers are kept in Settings, unsaved, so ask only when there are some. */
function requestClose(): void {
  if (!G.dialog) return;
  if (!k.dirty()) return close();
  if (G.dialog.querySelector('.guide-leave')) return;
  const stay = h('button', { type: 'button', class: 'btn btn-primary' }, 'Keep going');
  const leave = h('button', { type: 'button', class: 'btn' }, 'Leave the guide');
  const box = h('div', { class: 'guide-leave', role: 'alertdialog', 'aria-label': 'Leave the setup guide?' },
    h('div', { class: 'guide-leave-box' },
      h('strong', {}, 'Leave the setup guide?'),
      p('Your answers stay filled in under Settings, but they are not saved until you press Save there.'),
      h('div', { class: 'dialog-actions' }, leave, stay),
    ),
  );
  stay.addEventListener('click', () => box.remove());
  leave.addEventListener('click', () => close());
  G.dialog.append(box);
  stay.focus();
}

function close(): void {
  const d = G.dialog;
  if (!d) return;
  G.dialog = null;
  window.removeEventListener(CHROME_LAUNCH_EVENT, onChromeLaunch);
  d.close();
  d.remove();
  k.beginPage();
  G.opts?.onClose();
}

export function openSetupGuide(kit: SettingsKit, opts: Options): void {
  if (G.dialog) return;
  k = kit;
  G.opts = opts;
  G.topics = topicsFromSettings();
  G.index = 0;
  G.visited = new Set();
  G.errors = [];
  G.saved = false;
  G.steps = [];
  void detect();
  buildSteps();

  const closeBtn = h('button', { type: 'button', class: 'guide-close', title: 'Close (Esc)', 'aria-label': 'Close the setup guide' }, '✕');
  closeBtn.addEventListener('click', requestClose);
  const dialog = h('dialog', { class: 'guide', 'aria-label': 'Setup guide' },
    h('div', { class: 'guide-top' },
      h('span', { class: 'guide-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'guide-name' }, 'Setup guide'),
      h('span', { class: 'spacer' }),
      closeBtn,
    ),
    h('div', { class: 'guide-body' },
      h('nav', { class: 'guide-rail', 'aria-label': 'Steps' }),
      h('main', { class: 'guide-main' }),
    ),
    h('footer', { class: 'guide-foot' }),
  ) as HTMLDialogElement;
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    const leave = dialog.querySelector('.guide-leave');
    if (leave) leave.remove();
    else requestClose();
  });
  document.body.append(dialog);
  G.dialog = dialog;
  window.addEventListener(CHROME_LAUNCH_EVENT, onChromeLaunch);
  dialog.showModal();
  renderStep();
  // Not the close button, which showModal focuses first: start reading at the top.
  dialog.querySelector<HTMLElement>('.guide-head h2')?.focus();
}
