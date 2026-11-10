// Every string the plugin shows, in each language it speaks. Plain TypeScript only, so the worker,
// its core modules and the panel share it. Decisions never depend on these texts.

export type Lang = 'en' | 'fr'
export const LANGS: readonly Lang[] = ['en', 'fr']

/** The language a BCP-47 tag asks for, when the plugin speaks it. */
export function langFrom(tag: unknown): Lang | null {
  if (typeof tag !== 'string') {
    return null
  }
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  return LANGS.find((lang) => lang === primary) ?? null
}

const en = {
  // Panel
  orcaDefault: 'Orca default (globally selected account)',
  addedByHand: ' · added by hand',
  folderMissingSuffix: ' (folder missing)',
  signInNeededSuffix: ' (sign-in needed)',
  unknownAccount: (id: string) => `Unknown account ${id}`,
  checkingUsage: 'Checking usage',
  resets: 'resets',
  checked: 'checked',
  usageOf: (window: string) => `${window} usage`,
  staleProject: 'Project no longer listed in Orca',
  workspaces: (count: number) => `${count} workspace${count === 1 ? '' : 's'}`,
  accountOf: (project: string) => `${project} account`,
  untilFixedDeny: 'Until this is fixed, new Claude launches in this project will be refused.',
  untilFixedPass: 'Until this is fixed, new Claude launches in this project run with the account selected in Orca.',
  runDirectlyTitle: 'To run it directly in a terminal',
  runDirectlyHint: 'The pin does not apply to claude typed by hand. Use this command:',
  loginFolder: 'folder',
  loginThen: 'then /login',
  accountsAndUsage: 'Accounts and usage',
  accountsEmpty: 'Claude accounts you add in Orca Settings → Accounts appear here.',
  badgeSelected: 'Orca selection',
  badgeSignInNeeded: 'Sign-in needed',
  badgeFolderMissing: 'Folder missing',
  removeFolder: 'Remove this account folder',
  showUsage: "Show each account's usage",
  showUsageHint:
    "When on, while the panel is open, reads each account's stored login token and asks Anthropic's usage API, the same way as Orca's usage bar. The token is used only for this request and is never stored.",
  addByHandTitle: 'Add an account folder by hand',
  addByHandHint: "Sign in with that folder first. Orca's status display and shared settings apply only to Orca accounts.",
  nameLabel: 'Name',
  namePlaceholder: 'e.g. Work account',
  folderLabel: 'CLAUDE_CONFIG_DIR folder',
  add: 'Add',
  refresh: 'Refresh',
  requestFailed: 'The request could not be processed',
  loading: 'Loading',
  intro: (selected: string) =>
    `Applies to newly opened Claude terminals. Restored or resumed sessions, native chat, claude typed by hand, and launches right after Orca starts use the account selected in Orca (${selected}).`,
  noProjectsTitle: 'No projects',
  noProjectsDescription: 'Repositories you add to Orca appear here.',
  dataFolder: (folder: string | null) => `Orca data folder: ${folder ?? 'Unknown (set it in the settings)'}`,

  // Worker
  statusCheckAccount: 'Claude Pin: check account',
  statusTooltip: (account: string) =>
    `New Claude terminals run with ${account}. Restored or resumed sessions and claude typed by hand use the account selected in Orca.`,
  unknownProject: 'Unknown project.',
  noSuchAccount: 'No such account.',
  folderNotAbsolute: 'The account folder must be an absolute path.',
  defaultFolderRefused: 'The default folder ~/.claude cannot be used.',
  folderMissing: 'The folder does not exist. Sign in to Claude with that folder first.',
  folderAlreadyAdded: 'This folder is already added.',
  accountInUse: 'A project uses this account. Unpin it first.',

  // Router, repo, accounts
  ambiguousPath: (path: string, project: string) =>
    `${path} exists both on this machine and on a remote host, so the pin of project ${project} cannot be applied.`,
  claudeNotRouted: (project: string) =>
    `The plugin's Routed agents setting does not include claude, so the pin of project ${project} does not apply.`,
  accountNotFound: (project: string, id: string) =>
    `The Claude account (${id}) pinned to project ${project} cannot be found. Pin it again in the Claude Pin panel.`,
  accountSignedOut: (project: string, account: string) =>
    `The Claude account (${account}) pinned to project ${project} is not signed in.`,
  windowsNeedsDefault: (account: string) =>
    `On Windows, Orca's account selection must be System default for the project pin (${account}) to apply.`,
  workspaceNotFound: (workspaceId: string) =>
    `Claude Pin could not find where workspace ${workspaceId} is. Try again in a moment.`,
  projectUnknown: (path: string, reason: string) => `Claude Pin could not determine the project of ${path}: ${reason}`,
  staleWorktree: 'The worktree is not where its repository has it registered. Run git worktree repair.',
  otherPluginFolder: (project: string, folder: string) =>
    `Another plugin set the Claude account folder of project ${project} to ${folder}.`,
  commandSetsFolder: (project: string) =>
    `The launch command sets CLAUDE_CONFIG_DIR, so the pin of project ${project} cannot be applied. Check the agent command setting.`,
  agentTeams: (project: string, account: string) =>
    `Agent Teams only run with the account selected in Orca. To use the account pinned to project ${project} (${account}), launch regular Claude.`,
  orcaAccountSignedOut: (shortId: string) => `Orca account ${shortId} (not signed in)`,

  // Usage
  windowFiveHour: '5-hour',
  windowWeekly: 'Weekly',
  windowWeeklyModel: (model: string) => `Weekly (${model})`,
  usageExpired: 'The token has expired. Run Claude once with this account to refresh it.',
  usageRateLimited: 'Usage requests are temporarily rate limited.',
  usageHttp: (status: number) => `The usage server responded with ${status}.`,
  usageNoLimits: 'This account has no usage limits to show.',
  usageBadResponse: 'Could not read the usage response.',
  usageNoToken: 'No stored login token was found.',
  usageNetwork: (code: string) => `Could not reach the usage server (${code}).`
}

export type Messages = typeof en

const fr: Messages = {
  // Panel
  orcaDefault: 'Orca par défaut (compte sélectionné globalement)',
  addedByHand: ' · ajouté à la main',
  folderMissingSuffix: ' (dossier introuvable)',
  signInNeededSuffix: ' (connexion requise)',
  unknownAccount: (id) => `Compte inconnu ${id}`,
  checkingUsage: 'Vérification de l’utilisation',
  resets: 'réinitialisation',
  checked: 'vérifié',
  usageOf: (window) => `Utilisation ${window}`,
  staleProject: 'Projet qui n’est plus listé dans Orca',
  workspaces: (count) => `${count} workspace${count > 1 ? 's' : ''}`,
  accountOf: (project) => `Compte de ${project}`,
  untilFixedDeny: 'Tant que ce n’est pas corrigé, les nouveaux lancements de Claude dans ce projet seront refusés.',
  untilFixedPass:
    'Tant que ce n’est pas corrigé, les nouveaux lancements de Claude dans ce projet utilisent le compte sélectionné dans Orca.',
  runDirectlyTitle: 'Pour le lancer directement dans un terminal',
  runDirectlyHint: 'L’épinglage ne s’applique pas à claude tapé à la main. Utilisez cette commande :',
  loginFolder: 'dossier',
  loginThen: 'puis /login',
  accountsAndUsage: 'Comptes et utilisation',
  accountsEmpty: 'Les comptes Claude ajoutés dans Orca, Réglages → Accounts, apparaissent ici.',
  badgeSelected: 'Sélection Orca',
  badgeSignInNeeded: 'Connexion requise',
  badgeFolderMissing: 'Dossier introuvable',
  removeFolder: 'Retirer ce dossier de compte',
  showUsage: 'Afficher l’utilisation de chaque compte',
  showUsageHint:
    'Une fois activé, tant que le panneau est ouvert, lit le jeton de connexion enregistré de chaque compte et interroge l’API d’utilisation d’Anthropic, comme la barre d’utilisation d’Orca. Le jeton sert uniquement à cette requête et n’est jamais enregistré.',
  addByHandTitle: 'Ajouter un dossier de compte à la main',
  addByHandHint:
    'Connectez-vous d’abord avec ce dossier. L’affichage d’état et les réglages partagés d’Orca ne s’appliquent qu’aux comptes Orca.',
  nameLabel: 'Nom',
  namePlaceholder: 'ex. : Compte pro',
  folderLabel: 'Dossier CLAUDE_CONFIG_DIR',
  add: 'Ajouter',
  refresh: 'Actualiser',
  requestFailed: 'La requête n’a pas pu être traitée',
  loading: 'Chargement',
  intro: (selected) =>
    `S’applique aux terminaux Claude nouvellement ouverts. Les sessions restaurées ou reprises, le chat natif, claude tapé à la main et les lancements juste après le démarrage d’Orca utilisent le compte sélectionné dans Orca (${selected}).`,
  noProjectsTitle: 'Aucun projet',
  noProjectsDescription: 'Les dépôts ajoutés à Orca apparaissent ici.',
  dataFolder: (folder) => `Dossier de données Orca : ${folder ?? 'inconnu (à définir dans les réglages)'}`,

  // Worker
  statusCheckAccount: 'Claude Pin : compte à vérifier',
  statusTooltip: (account) =>
    `Les nouveaux terminaux Claude utilisent ${account}. Les sessions restaurées ou reprises et claude tapé à la main utilisent le compte sélectionné dans Orca.`,
  unknownProject: 'Projet inconnu.',
  noSuchAccount: 'Ce compte n’existe pas.',
  folderNotAbsolute: 'Le dossier du compte doit être un chemin absolu.',
  defaultFolderRefused: 'Le dossier par défaut ~/.claude ne peut pas être utilisé.',
  folderMissing: 'Le dossier n’existe pas. Connectez-vous d’abord à Claude avec ce dossier.',
  folderAlreadyAdded: 'Ce dossier est déjà ajouté.',
  accountInUse: 'Un projet utilise ce compte. Retirez d’abord l’épinglage.',

  // Router, repo, accounts
  ambiguousPath: (path, project) =>
    `${path} existe à la fois sur cette machine et sur un hôte distant : l’épinglage du projet ${project} ne peut pas être appliqué.`,
  claudeNotRouted: (project) =>
    `Le réglage Routed agents du plugin ne contient pas claude : l’épinglage du projet ${project} ne s’applique pas.`,
  accountNotFound: (project, id) =>
    `Le compte Claude (${id}) épinglé au projet ${project} est introuvable. Épinglez-le à nouveau dans le panneau Claude Pin.`,
  accountSignedOut: (project, account) => `Le compte Claude (${account}) épinglé au projet ${project} n’est pas connecté.`,
  windowsNeedsDefault: (account) =>
    `Sous Windows, la sélection de compte d’Orca doit être System default pour que l’épinglage du projet (${account}) s’applique.`,
  workspaceNotFound: (workspaceId) =>
    `Claude Pin n’a pas trouvé l’emplacement du workspace ${workspaceId}. Réessayez dans un instant.`,
  projectUnknown: (path, reason) => `Claude Pin n’a pas pu déterminer le projet de ${path} : ${reason}`,
  staleWorktree:
    'Le worktree n’est pas à l’emplacement enregistré par son dépôt. Lancez git worktree repair.',
  otherPluginFolder: (project, folder) =>
    `Un autre plugin a défini le dossier de compte Claude du projet ${project} sur ${folder}.`,
  commandSetsFolder: (project) =>
    `La commande de lancement définit CLAUDE_CONFIG_DIR : l’épinglage du projet ${project} ne peut pas être appliqué. Vérifiez le réglage de commande de l’agent.`,
  agentTeams: (project, account) =>
    `Agent Teams utilise uniquement le compte sélectionné dans Orca. Pour utiliser le compte épinglé au projet ${project} (${account}), lancez Claude normalement.`,
  orcaAccountSignedOut: (shortId) => `Compte Orca ${shortId} (non connecté)`,

  // Usage
  windowFiveHour: '5 heures',
  windowWeekly: 'Hebdomadaire',
  windowWeeklyModel: (model) => `Hebdomadaire (${model})`,
  usageExpired: 'Le jeton a expiré. Lancez Claude une fois avec ce compte pour le renouveler.',
  usageRateLimited: 'Les requêtes d’utilisation sont temporairement limitées.',
  usageHttp: (status) => `Le serveur d’utilisation a répondu ${status}.`,
  usageNoLimits: 'Ce compte n’a aucune limite d’utilisation à afficher.',
  usageBadResponse: 'Impossible de lire la réponse d’utilisation.',
  usageNoToken: 'Aucun jeton de connexion enregistré n’a été trouvé.',
  usageNetwork: (code) => `Impossible de joindre le serveur d’utilisation (${code}).`
}

const catalogs: Record<Lang, Messages> = { en, fr }

export function messages(lang: Lang): Messages {
  return catalogs[lang]
}
