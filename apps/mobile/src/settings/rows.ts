// The words of the rows of Settings that are the phone's own (the computer's
// fields have theirs in the shared catalog). The tabs show them and the
// settings search (search.ts) looks through them, so a result says what its
// row says.

/** Under a CLI's switch, as the desktop says it. */
export const harnessHelp = (id: string): string => `Scan for ${id} sessions, show them, and offer it when starting one`;

export const TEMPLATES = {
  label: 'Project Templates',
  help: 'One folder per template, each with a template.json and the files a new project starts with. Add a folder to add a template.',
  none: 'No templates folder on the computer.',
} as const;

/** The Computer tab's rows and buttons. */
export const COMPUTER = {
  route: 'Connect through',
  desktopVersion: 'Paired Switchboard Evolution',
  mobileVersion: 'This Switchboard Mobile',
  source: 'Source code',
  sourceAddress: 'github.com/vivi7/switchboard-evolution',
  device: 'This phone on the computer',
  addresses: 'Addresses',
  paired: 'Paired',
  reconnect: 'Reconnect now',
  pairAgain: 'Pair again',
  forget: 'Forget this computer',
} as const;

export const desktopVersionText = (version: string | null | undefined): string => (version ? `version ${version}` : 'not connected');
export const mobileVersionText = (version: string | null): string => (version ? `version ${version}` : 'unknown');
export const addressesText = (desktop: { addresses: string[]; port: number }): string => `${desktop.addresses.join(', ')} (port ${desktop.port})`;
export const pairedText = (desktop: { pairedAt: number }): string => new Date(desktop.pairedAt).toLocaleString();

export const IMPROVER_INTRO = 'The ✦ button beside “/” in a session rewrites the prompt you are writing, with the commands, skills and MCP servers the session has. The computer runs the CLI you are signed in to, once and out of sight, on your subscription. Nothing is sent for you.';

/** The Prompt Improver tab's rows. */
export const IMPROVER = {
  enabled: { label: 'Prompt improver' },
  confirm: { label: 'Ask before improving', help: 'A question before each run.' },
  engine: { label: 'CLI that rewrites', help: 'The commands and skills offered are always those of the session the prompt is for.' },
  context: { label: 'Context' },
  turns: { label: 'Last turns', help: 'Messages of the conversation that go with the prompt.' },
  models: { label: 'Models', help: 'As each CLI names them. Empty: the CLI\'s default.' },
  timeout: { label: 'Time limit', help: 'Seconds before a run is stopped.' },
  template: { label: 'Improver prompt', help: 'The instructions the CLI follows. The context the app adds after it is not shown.' },
  reset: { label: 'Reset the improver prompt to the default' },
} as const;

/** Whose the improver prompt is. */
export const templateOwner = (custom: boolean): string => (custom ? 'Yours' : 'The default one');
