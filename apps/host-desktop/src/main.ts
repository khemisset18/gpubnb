import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { completeIntroduction, readOnboardingState } from './onboarding-state';
import './styles.css';
import './pairing.css';

type Lifecycle = 'setup_required' | 'ready' | 'online' | 'emergency_stopped';
type Check = { id: string; label: string; ok: boolean; detail: string; actionLabel?: string | null };
type PairingConfiguration = { configured: boolean; browserUrl?: string | null; storesPassword: boolean; explanation: string };
type AgentStatus = { installed: boolean; linked: boolean; running: boolean; machineId?: string | null; detail: string };
type GpuDevice = { index: number; uuid: string; model: string; driverVersion: string; vramMib: number };
type NativeDiagnostic = { canHost: boolean; reason: string; gpus?: GpuDevice[] };
type MiningRuntimeStatus = {
  runtime: {
    state: string;
    consent: string;
    autoResumeAfterRental: boolean;
    reservationId?: string | null;
    lastError?: string | null;
  };
  process: {
    status: 'stopped' | 'running' | 'exited';
    pid?: number | null;
    profileId?: string | null;
    lastExitCode?: number | null;
  };
};
type MiningRuntimeRead = { status: MiningRuntimeStatus | null; error: string | null };
type MinerInstallationStatus = {
  profileId: string;
  version: string;
  archiveName: string;
  sourceUrl: string;
  installed: boolean;
  verified: boolean;
  verificationError?: string | null;
};
type MinerInstallationRead = { status: MinerInstallationStatus | null; error: string | null };
type MiningTelemetry = {
  available: boolean;
  deviceName?: string | null;
  hashrate?: number | null;
  hashrateUnit?: string | null;
  acceptedShares?: number | null;
  staleShares?: number | null;
  hardwareErrors?: number | null;
  temperatureCelsius?: number | null;
  powerWatts?: number | null;
  uptimeSeconds?: number | null;
  poolConnected: boolean;
};
type MiningThermalSafety = {
  latched: boolean;
  lastTemperatureCelsius?: number | null;
  warningCelsius: number;
  stopCelsius: number;
  rearmCelsius: number;
};
type MiningConfiguration = {
  enabled: boolean;
  autoMineWhenIdle: boolean;
  cryptocurrency: string;
  minerProfileId: string;
  poolMode: 'custom';
  customPoolUrl: string;
  walletAddress: string;
  workerName: string;
  poolCredentialRef: null;
};
type MiningConfigurationView = {
  configured: boolean;
  configuration?: Omit<MiningConfiguration, 'poolCredentialRef'> & { hasPoolCredential: boolean } | null;
  status?: 'disabled' | 'needs_connection_test' | 'ready' | null;
  revision: number;
  connectionVerifiedAtUnixSeconds?: number | null;
};
type HostStatus = {
  platform: string;
  architecture: string;
  ready: boolean;
  lifecycle: Lifecycle;
  progress: number;
  blockingCount: number;
  summary: string;
  nextActionId?: string | null;
  pairing: PairingConfiguration;
  agent: AgentStatus;
  diagnostic: NativeDiagnostic;
  checks: Check[];
};

type MessageTone = 'info' | 'success' | 'error';
type AppView = 'host' | 'mining';
type DisplayCurrency = 'USD' | 'EUR' | 'JPY' | 'GBP' | 'CNY';

const OFFICIAL_ORIGINS = new Set(['https://gpubnb.com', 'https://app.gpubnb.com', 'https://gpubnb.netlify.app']);
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]{3,124}$/;

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing_app_root');
const app = root;
let activeView: AppView = 'host';
let selectedMiningCoin = 'XMR';
const DISPLAY_CURRENCIES: DisplayCurrency[] = ['USD', 'EUR', 'JPY', 'GBP', 'CNY'];
const savedCurrency = window.localStorage.getItem('gpubnb-mining-currency');
let displayCurrency: DisplayCurrency = DISPLAY_CURRENCIES.includes(savedCurrency as DisplayCurrency)
  ? savedCurrency as DisplayCurrency
  : 'USD';
let refreshTimer: number | undefined;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
})[char] ?? char);

const lifecycleLabel = (lifecycle: Lifecycle): string => ({
  setup_required: 'Configuration',
  ready: 'Prêt',
  online: 'En ligne',
  emergency_stopped: 'Arrêté',
})[lifecycle];

const formatVram = (mib: number): string => `${Math.round((mib / 1024) * 10) / 10} Go`;

const diagnosticDetail = (reason: string): string => ({
  operating_system_not_supported: "Ce système d’exploitation n’est pas pris en charge.",
  architecture_not_supported: "L’architecture du processeur n’est pas prise en charge.",
  nvidia_gpu_not_detected: 'Aucun GPU NVIDIA compatible n’a été détecté.',
  docker_not_installed: 'Docker doit être installé avant la mise en location.',
  docker_daemon_unreachable: 'Docker est installé, mais son service ne répond pas.',
  nvidia_container_runtime_missing: 'Le runtime NVIDIA pour conteneurs est absent.',
  hardware_isolation_unavailable: 'La virtualisation matérielle ou son accès sécurisé est indisponible.',
  native_prerequisites_ready: 'Le matériel et les prérequis techniques sont prêts.',
})[reason] ?? 'Une vérification technique obligatoire a échoué.';

const pairingErrorMessage = (error: unknown): string => {
  const value = String(error);
  if (value.includes('invalid_link_code')) return 'Le code doit contenir exactement 10 caractères hexadécimaux.';
  if (value.includes('agent_not_installed')) return 'Le service GPUbnb n’est pas présent dans cette version. Réinstallez le paquet Windows complet.';
  if (value.includes('agent_setup_required')) return 'Préparation locale requise : installez le service GPUbnb, puis réessayez.';
  if (value.includes('agent_not_linked')) return 'Cette machine doit d’abord être reliée avec un code GPUbnb valide.';
  if (value.includes('agent_link_not_persisted')) return 'La liaison n’a pas été sauvegardée par le service local.';
  if (value.includes('agent_key_already_registered')) return 'Cette clé agent est déjà reliée à un autre compte. Réinitialisez la clé puis recréez un code.';
  if (value.includes('agent_link_failed')) return 'Le code a été refusé, a expiré ou a déjà été utilisé.';
  if (value.includes('storage_protection_unverified')) return 'Docker n’a pas confirmé le stockage isolé et sans montage hôte. La mise en ligne reste bloquée.';
  if (value.includes('network_filter_unverified')) return 'Docker n’a pas confirmé la coupure réseau du conteneur de contrôle. La mise en ligne reste bloquée.';
  if (value.includes('agent_command_failed')) return 'Le service GPUbnb n’a pas pu exécuter la commande demandée.';
  return 'La liaison ou la configuration n’a pas abouti. La machine reste hors ligne.';
};

const setMessage = (message: string, tone: MessageTone = 'info', fallbackUrl?: string): void => {
  const node = document.querySelector<HTMLElement>('#action-status');
  if (!node) return;
  node.dataset.tone = tone;
  node.replaceChildren(document.createTextNode(message));

  if (fallbackUrl) {
    const link = document.createElement('a');
    link.className = 'fallback-link';
    link.href = fallbackUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Ouvrir dans le navigateur';
    node.append(document.createTextNode(' '), link);
  }
};

const officialUrl = (rawUrl: string): URL | null => {
  try {
    const url = new URL(rawUrl);
    if (!OFFICIAL_ORIGINS.has(url.origin) || url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
};

const officialMinerUrl = (installation: MinerInstallationStatus): URL | null => {
  try {
    const url = new URL(installation.sourceUrl);
    const expectedPath = installation.profileId === 'xmrig_randomx'
      ? `/xmrig/xmrig/releases/download/v${installation.version}/${installation.archiveName}`
      : installation.profileId.startsWith('lolminer_')
        ? `/Lolliedieb/lolMiner-releases/releases/download/${installation.version}/${installation.archiveName}`
        : '';
    if (!expectedPath || url.origin !== 'https://github.com' || url.pathname !== expectedPath || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
};

const openOfficialUrl = (url: URL, successMessage: string): void => {
  const href = url.toString();
  void openUrl(href).then(() => {
    setMessage(`${successMessage} Si rien ne s’ouvre, utilisez le lien suivant.`, 'success', href);
  }).catch(() => {
    setMessage("Le navigateur n’a pas pu s’ouvrir automatiquement.", 'error', href);
  });
};

const listingUrl = (baseUrl: string, machineId: string, gpuUuid: string): URL | null => {
  if (!MACHINE_ID_PATTERN.test(machineId) || !GPU_UUID_PATTERN.test(gpuUuid)) return null;
  const url = officialUrl(baseUrl);
  if (!url) return null;
  url.pathname = '/host/listings/new';
  url.search = '';
  url.searchParams.set('machineId', machineId);
  url.searchParams.set('gpuUuid', gpuUuid);
  url.searchParams.set('source', 'host-desktop');
  return url;
};

const renderChecks = (checks: Check[]): string => checks.map((check) => `
  <li class="check ${check.ok ? 'ok' : 'blocked'}">
    <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : '!'}</span>
    <div class="check-copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div>
    ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
  </li>`).join('');

const renderPairing = (status: HostStatus): string => {
  if (status.agent.linked && status.agent.machineId) return `<section class="explanation pairing-guide">
    <p class="eyebrow">Machine associée</p><h2>Ce Host est relié à votre compte</h2><p>${escapeHtml(status.agent.detail)}</p>
    <div class="machine-identity"><span>Identifiant machine</span><code>${escapeHtml(status.agent.machineId)}</code></div></section>`;

  return `<section class="explanation pairing-guide"><p class="eyebrow">Connexion sécurisée</p><h2>Reliez cet ordinateur à votre compte</h2>
    <p>${status.pairing.configured ? 'Connectez-vous sur GPUbnb, générez un code temporaire puis saisissez-le ci-dessous.' : 'Le service officiel de liaison n’est pas configuré dans cette version.'}</p>
    ${status.pairing.configured ? `<form id="pairing-form" class="pairing-form" novalidate><label for="pairing-code">Code de liaison</label><div class="pairing-controls">
      <input id="pairing-code" autocomplete="one-time-code" inputmode="text" maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="A1B2C3D4E5" required>
      <button id="pairing-submit" class="primary large" type="submit">Relier cette machine</button></div><small>Le mot de passe du compte n’est jamais transmis à l’application.</small></form>` : ''}
    <p>${escapeHtml(status.pairing.explanation)}</p></section>`;
};

const renderGpuInventory = (status: HostStatus): string => {
  const gpus = status.diagnostic.gpus ?? [];
  if (gpus.length === 0) return `<section class="gpu-inventory"><p class="eyebrow">Matériel détecté</p><h2>Aucun GPU publié</h2><p>${escapeHtml(diagnosticDetail(status.diagnostic.reason))}</p></section>`;

  const canCreateListing = Boolean(
    status.agent.linked
    && status.agent.machineId
    && MACHINE_ID_PATTERN.test(status.agent.machineId)
    && status.pairing.browserUrl
    && officialUrl(status.pairing.browserUrl),
  );

  return `<section class="gpu-inventory"><div class="inventory-heading"><div><p class="eyebrow">Matériel détecté automatiquement</p><h2>${gpus.length} GPU ${gpus.length > 1 ? 'détectés' : 'détecté'}</h2></div><span class="badge">Données techniques vérifiées</span></div>
    <div class="gpu-grid">${gpus.map((gpu) => {
      const valid = Number.isInteger(gpu.index) && gpu.index >= 0 && GPU_UUID_PATTERN.test(gpu.uuid) && gpu.vramMib > 0;
      return `<article class="gpu-card"><div><span class="gpu-index">GPU ${valid ? gpu.index : '?'}</span><h3>${escapeHtml(gpu.model)}</h3></div>
        <dl><div><dt>Mémoire</dt><dd>${valid ? formatVram(gpu.vramMib) : 'Invalide'}</dd></div><div><dt>Pilote</dt><dd>${escapeHtml(gpu.driverVersion)}</dd></div></dl>
        <code title="${escapeHtml(gpu.uuid)}">${escapeHtml(gpu.uuid)}</code>
        <button class="primary create-listing" data-gpu-uuid="${escapeHtml(gpu.uuid)}" ${canCreateListing && valid ? '' : 'disabled'}>Nouvelle annonce</button>
      </article>`;
    }).join('')}</div></section>`;
};

const miningStateLabel = (state: string): string => ({
  idle: 'Inactif',
  mining_starting: 'Démarrage',
  mining: 'Minage actif',
  preempting_mining: 'Arrêt prioritaire',
  verifying_rental_readiness: 'Préparation de location',
  rental_ready: 'Location prête',
  rental_active: 'Location active',
  cleaning_rental: 'Nettoyage',
  quarantined: 'Quarantaine',
  emergency_stopped: 'Arrêt d’urgence',
})[state] ?? 'État inconnu';

type MiningCatalogEntry = {
  symbol: string;
  name: string;
  profileId?: string;
  hardwareValidated?: boolean;
};

const MINING_CATALOG: MiningCatalogEntry[] = [
  { symbol: 'XMR', name: 'Monero', profileId: 'xmrig_randomx', hardwareValidated: true },
  { symbol: 'PRL', name: 'Pearl' },
  { symbol: 'ALPH', name: 'Alephium', profileId: 'lolminer_blake3', hardwareValidated: true },
  { symbol: 'KAS', name: 'Kaspa' },
  { symbol: 'ETC', name: 'Ethereum Classic', profileId: 'lolminer_etchash' },
  { symbol: 'CFX', name: 'Conflux', profileId: 'lolminer_octopus' },
  { symbol: 'RVN', name: 'Ravencoin' },
  { symbol: 'NEOX', name: 'Neoxa' },
];

const renderMiningCatalog = (): string => `<section class="mining-catalog">
  <div class="catalog-heading"><div><p class="eyebrow">Catalogue multi-crypto</p><h2>Choisissez votre cryptomonnaie</h2></div>
    <label class="currency-selector">Devise<select id="mining-currency" aria-label="Devise d’affichage">${DISPLAY_CURRENCIES.map((currency) => `<option value="${currency}" ${currency === displayCurrency ? 'selected' : ''}>${currency}</option>`).join('')}</select></label></div>
  <div class="catalog-grid">${MINING_CATALOG.map((entry) => `<article class="catalog-card ${selectedMiningCoin === entry.symbol ? 'selected' : ''}">
    <div class="catalog-card-heading"><div><span class="coin-symbol">${escapeHtml(entry.symbol)}</span><h3>${escapeHtml(entry.name)}</h3></div>${entry.hardwareValidated ? '<span class="catalog-validation">✓ Test réel validé</span>' : ''}</div>
    <div class="profit-estimate"><span>Rendement estimé</span><strong>— ${displayCurrency}/jour</strong><small>${entry.hardwareValidated ? 'Mesures disponibles · source de prix à raccorder' : 'Calculé après le test réel de cette carte'}</small></div>
    <button class="${selectedMiningCoin === entry.symbol ? 'primary' : 'secondary'} catalog-select" data-coin="${escapeHtml(entry.symbol)}">${selectedMiningCoin === entry.symbol ? 'Sélectionnée' : 'Sélectionner'}</button>
  </article>`).join('')}</div>
</section>`;

const formatDuration = (seconds?: number | null): string => {
  if (typeof seconds !== 'number') return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${hours} h ${minutes} min ${remaining} s`;
};

const formatMetric = (value: number | null | undefined, unit: string): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(value < 10 ? 1 : 0)} ${unit}` : '—'
);

const renderMiningTelemetry = (telemetry: MiningTelemetry | null): string => {
  if (!telemetry?.available) return `<section class="mining-performance unavailable"><div class="performance-heading"><div><p class="eyebrow">Rendement réel</p><h2>Mesures en attente</h2></div><span class="badge">Aucune session mesurée</span></div>
    <p>Le tableau sera alimenté automatiquement après le démarrage du mineur.</p></section>`;
  const temperature = telemetry.temperatureCelsius;
  const thermalState = typeof temperature !== 'number' ? 'unknown' : temperature >= 85 ? 'danger' : temperature >= 80 ? 'warning' : 'safe';
  return `<section class="mining-performance ${thermalState}"><div class="performance-heading"><div><p class="eyebrow">Rendement réel</p><h2>Tableau de minage</h2></div><span class="badge">Actualisation automatique</span></div>
    ${thermalState === 'danger' ? '<div class="thermal-alert">Température excessive détectée. La protection native arrête automatiquement le minage à 85 °C.</div>' : ''}
    <dl class="performance-grid">
      <div><dt>Matériel</dt><dd>${escapeHtml(telemetry.deviceName ?? '—')}</dd></div>
      <div><dt>Hashrate</dt><dd>${formatMetric(telemetry.hashrate, telemetry.hashrateUnit ?? 'H/s')}</dd></div>
      <div><dt>Température</dt><dd>${formatMetric(temperature, '°C')}</dd></div>
      <div><dt>Puissance</dt><dd>${formatMetric(telemetry.powerWatts, 'W')}</dd></div>
      <div><dt>Parts A/S/Hw</dt><dd>${telemetry.acceptedShares ?? '—'} / ${telemetry.staleShares ?? '—'} / ${telemetry.hardwareErrors ?? '—'}</dd></div>
      <div><dt>Durée mesurée</dt><dd>${formatDuration(telemetry.uptimeSeconds)}</dd></div>
      <div><dt>Pool</dt><dd>${telemetry.poolConnected ? 'Connecté' : 'Non confirmé'}</dd></div>
      <div><dt>Estimation</dt><dd>— ${displayCurrency}/jour</dd><small>Source de prix non raccordée</small></div>
    </dl>
    <p class="performance-note">Les parts et mesures sont réelles. Le montant restera vide tant que le rendement réseau et le cours ${displayCurrency} ne sont pas disponibles de façon fiable.</p></section>`;
};

const renderMiningRuntime = (
  coin: MiningCatalogEntry,
  read: MiningRuntimeRead,
  installationRead: MinerInstallationRead,
  configuration: MiningConfigurationView | null,
  telemetry: MiningTelemetry | null,
  thermalSafety: MiningThermalSafety | null,
): string => {
  const installation = installationRead.status;
  const minerName = coin.profileId === 'xmrig_randomx' ? 'XMRig' : 'lolMiner';
  const installReady = Boolean(installation?.verified);
  const installPanel = installation ? `<div class="miner-installation ${installReady ? 'verified' : 'required'}">
    <div><strong>${escapeHtml(minerName)} ${escapeHtml(installation.version)}</strong><small>${installReady ? 'Exécutable installé et empreinte vérifiée.' : installation.installed ? 'Installation présente mais non valide.' : 'Téléchargez l’archive officielle avant l’installation.'}</small></div>
    <div class="miner-install-actions">${installReady ? '<span class="verification-badge">✓ Vérifié</span>' : `<button id="download-miner" class="secondary">Télécharger</button><label class="consent-check"><input id="miner-consent" type="checkbox"> J’autorise l’installation de ${escapeHtml(minerName)}</label><button id="install-miner" class="primary" disabled>Installer depuis Téléchargements</button>`}</div>
    ${installation.verificationError && installation.installed ? `<code>${escapeHtml(installation.verificationError)}</code>` : ''}</div>`
    : `<div class="miner-installation required"><strong>Installation indisponible</strong><code>${escapeHtml(installationRead.error ?? 'miner_installation_status_unavailable')}</code></div>`;

  if (!read.status) return `<section class="mining-runtime unavailable"><div><p class="eyebrow">Minage personnel</p><h2>Runtime indisponible</h2></div>
    <p>Le lancement reste bloqué tant que le runtime natif n’est pas disponible.</p><code>${escapeHtml(read.error ?? 'miner_runtime_unavailable')}</code>${installPanel}</section>`;

  const { runtime, process } = read.status;
  const running = process.status === 'running' && typeof process.pid === 'number';
  const processLabel = running ? 'Processus confirmé' : process.status === 'exited' ? 'Processus terminé' : 'Aucun processus actif';
  const saved = configuration?.configuration;
  const configurationMatches = saved?.cryptocurrency === coin.symbol
    && saved?.minerProfileId === coin.profileId;
  const configurationReady = configurationMatches && configuration?.status === 'ready';
  const thermalLatched = thermalSafety?.latched === true;
  const thermalPanel = thermalLatched ? `<div class="thermal-alert thermal-latched"><strong>Protection thermique déclenchée</strong><span>Le mineur a été arrêté automatiquement à ${formatMetric(thermalSafety?.lastTemperatureCelsius, '°C')}. Attendez que la carte descende à ${thermalSafety?.rearmCelsius ?? 75} °C maximum.</span><button id="acknowledge-thermal-safety" class="secondary" type="button">Vérifier et réarmer</button></div>` : '';
  const configurationPanel = installReady ? `<form id="mining-configuration" class="mining-configuration" novalidate>
    <div class="configuration-heading"><div><strong>Pool ${escapeHtml(coin.symbol)} personnel</strong><small>${configurationReady ? 'Connexion vérifiée. Le démarrage est autorisé.' : 'Enregistrez puis testez la connexion avant le démarrage.'}</small></div><span class="verification-badge ${configurationReady ? '' : 'pending'}">${configurationReady ? '✓ Prêt' : 'Test requis'}</span></div>
    <div class="configuration-fields"><label>Adresse du pool<input id="mining-pool" value="${escapeHtml(configurationMatches ? saved?.customPoolUrl ?? '' : '')}" placeholder="stratum+tls://pool.example.com:443" required></label>
    <label>Adresse du portefeuille ${escapeHtml(coin.symbol)}<input id="mining-wallet" value="${escapeHtml(configurationMatches ? saved?.walletAddress ?? '' : '')}" maxlength="192" required></label>
    <label>Nom de ce PC<input id="mining-worker" value="${escapeHtml(configurationMatches ? saved?.workerName ?? 'gpubnb-host' : 'gpubnb-host')}" maxlength="96" required></label></div>
    <div class="configuration-actions"><button id="save-mining" class="secondary" type="submit">Enregistrer</button><button id="test-mining" class="secondary" type="button" ${configurationMatches && configuration?.configured ? '' : 'disabled'}>Tester la connexion</button></div></form>` : '';
  return `<section class="mining-runtime ${running ? 'running' : ''}"><div class="runtime-heading"><div><p class="eyebrow">Minage personnel</p><h2>${escapeHtml(miningStateLabel(runtime.state))}</h2></div>
    <span class="status-pill ${running ? 'online' : ''}">${escapeHtml(processLabel)}</span></div>
    <dl class="runtime-details"><div><dt>Profil</dt><dd>${escapeHtml(process.profileId ?? 'Aucun')}</dd></div><div><dt>PID</dt><dd>${process.pid ?? '—'}</dd></div>
    <div><dt>Consentement</dt><dd>${escapeHtml(runtime.consent)}</dd></div><div><dt>Dernière sortie</dt><dd>${process.lastExitCode ?? '—'}</dd></div></dl>
    ${runtime.lastError ? `<p class="runtime-error">${escapeHtml(runtime.lastError)}</p>` : ''}${thermalPanel}${renderMiningTelemetry(telemetry)}${installPanel}${configurationPanel}
    <div class="mining-controls"><button id="start-mining" class="primary" ${installReady && configurationReady && !running && !thermalLatched ? '' : 'disabled'}>Démarrer le minage</button><button id="stop-mining" class="secondary" ${running ? '' : 'disabled'}>Arrêter le minage</button><button id="emergency-mining" class="danger-button">Arrêt d’urgence</button></div></section>`;
};

const miningErrorMessage = (error: unknown): string => {
  const value = String(error);
  if (value.includes('miner_installation_consent_required')) return 'Confirmez explicitement l’installation du mineur.';
  if (value.includes('miner_archive_unavailable')) return 'L’archive attendue est absente du dossier Téléchargements.';
  if (value.includes('miner_archive_hash_mismatch')) return 'L’archive téléchargée ne correspond pas à la version officielle approuvée.';
  if (value.includes('miner_archive_binary_hash_mismatch')) return 'L’exécutable contenu dans l’archive a une empreinte invalide.';
  if (value.includes('mining_pool_connection_test_required')) return 'Testez la connexion au pool avant de démarrer.';
  if (value.includes('mining_configuration_missing')) return 'Enregistrez la configuration de minage.';
  if (value.includes('miner_binary_missing')) return 'Installez d’abord le mineur approuvé.';
  if (value.includes('thermal_safety_review_required')) return 'Le redémarrage reste bloqué après un arrêt thermique. Laissez refroidir la carte puis cliquez sur « Vérifier et réarmer ».';
  if (value.includes('miner_temperature_still_too_high')) return 'La carte est encore trop chaude. Attendez qu’elle descende à 75 °C maximum.';
  if (value.includes('gpu_temperature_sensor_unavailable') || value.includes('gpu_temperature_sensor_invalid')) return 'Le capteur NVIDIA ne peut pas être vérifié. Le réarmement reste bloqué par sécurité.';
  return `Opération refusée : ${value}`;
};

const bindMining = (
  coin: MiningCatalogEntry,
  runtime: MiningRuntimeRead,
  installationRead: MinerInstallationRead,
  configuration: MiningConfigurationView | null,
): void => {
  const installation = installationRead.status;
  const minerName = coin.profileId === 'xmrig_randomx' ? 'XMRig' : 'lolMiner';
  const consent = document.querySelector<HTMLInputElement>('#miner-consent');
  const install = document.querySelector<HTMLButtonElement>('#install-miner');
  consent?.addEventListener('change', () => { if (install) install.disabled = !consent.checked; });
  document.querySelector<HTMLButtonElement>('#download-miner')?.addEventListener('click', () => {
    if (!installation) return;
    const target = officialMinerUrl(installation);
    if (!target) {
      setMessage('La source du mineur a été refusée car son adresse ne correspond pas au manifeste.', 'error');
      return;
    }
    openOfficialUrl(target, `Téléchargez ${installation.archiveName} sans le renommer.`);
  });
  install?.addEventListener('click', () => {
    if (!consent?.checked) return;
    install.disabled = true;
    setMessage(`Vérification et installation transactionnelle de ${minerName}…`);
    void invoke('install_approved_miner', { profileId: coin.profileId, consentConfirmed: true })
      .then(() => { setMessage(`${minerName} est installé et vérifié.`, 'success'); window.setTimeout(() => void refresh(), 500); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'))
      .finally(() => { install.disabled = false; });
  });

  document.querySelector<HTMLFormElement>('#mining-configuration')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const pool = document.querySelector<HTMLInputElement>('#mining-pool')?.value.trim() ?? '';
    const wallet = document.querySelector<HTMLInputElement>('#mining-wallet')?.value.trim() ?? '';
    const worker = document.querySelector<HTMLInputElement>('#mining-worker')?.value.trim() ?? '';
    const candidate: MiningConfiguration = { enabled: true, autoMineWhenIdle: true, cryptocurrency: coin.symbol, minerProfileId: coin.profileId ?? '', poolMode: 'custom', customPoolUrl: pool, walletAddress: wallet, workerName: worker, poolCredentialRef: null };
    setMessage('Enregistrement sécurisé de la configuration…');
    void invoke('mining_configuration_save', { expectedRevision: configuration?.revision ?? 0, configuration: candidate })
      .then(() => { setMessage('Configuration enregistrée. Testez maintenant le pool.', 'success'); window.setTimeout(() => void refresh(), 400); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  document.querySelector<HTMLButtonElement>('#test-mining')?.addEventListener('click', () => {
    setMessage('Test DNS, TCP et TLS du pool…');
    void invoke('mining_configuration_test_connection', { expectedRevision: configuration?.revision ?? 0 })
      .then(() => { setMessage('Connexion au pool vérifiée.', 'success'); window.setTimeout(() => void refresh(), 400); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  document.querySelector<HTMLButtonElement>('#start-mining')?.addEventListener('click', () => {
    setMessage('Démarrage du processus minier vérifié…');
    void invoke('set_idle_mining_mode', { consent: 'owner_pool' })
      .then(() => invoke('start_idle_mining'))
      .then(() => { setMessage('Minage démarré avec PID confirmé.', 'success'); window.setTimeout(() => void refresh(), 500); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  document.querySelector<HTMLButtonElement>('#stop-mining')?.addEventListener('click', () => {
    setMessage('Arrêt et confirmation du processus…');
    void invoke('set_idle_mining_mode', { consent: 'disabled' })
      .then(() => { setMessage('Processus minier arrêté.', 'success'); window.setTimeout(() => void refresh(), 400); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  document.querySelector<HTMLButtonElement>('#emergency-mining')?.addEventListener('click', () => {
    setMessage('Arrêt d’urgence en cours…', 'error');
    void invoke('emergency_stop')
      .then(() => void refresh())
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  document.querySelector<HTMLButtonElement>('#acknowledge-thermal-safety')?.addEventListener('click', () => {
    setMessage('Vérification de la température avant réarmement…');
    void invoke('acknowledge_mining_thermal_safety')
      .then(() => { setMessage('Protection thermique réarmée. Le démarrage manuel est de nouveau disponible.', 'success'); window.setTimeout(() => void refresh(), 400); })
      .catch((error: unknown) => setMessage(miningErrorMessage(error), 'error'));
  });
  void runtime;
};

const bindNavigation = (): void => {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (view !== 'host' && view !== 'mining') return;
    activeView = view;
    void refresh();
  }));
};

const bindCatalog = (): void => {
  document.querySelector<HTMLSelectElement>('#mining-currency')?.addEventListener('change', (event) => {
    const currency = (event.currentTarget as HTMLSelectElement).value as DisplayCurrency;
    if (!DISPLAY_CURRENCIES.includes(currency)) return;
    displayCurrency = currency;
    window.localStorage.setItem('gpubnb-mining-currency', currency);
    void refresh();
  });
  document.querySelectorAll<HTMLButtonElement>('.catalog-select').forEach((button) => button.addEventListener('click', () => {
    const coin = button.dataset.coin;
    if (!coin || !MINING_CATALOG.some((entry) => entry.symbol === coin)) return;
    selectedMiningCoin = coin;
    void refresh();
  }));
};

const bindPairing = (): void => {
  const input = document.querySelector<HTMLInputElement>('#pairing-code');
  input?.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 10);
    input.setCustomValidity('');
  });

  document.querySelector<HTMLFormElement>('#pairing-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#pairing-submit');
    const code = input?.value.trim().toUpperCase() ?? '';
    if (!/^[A-F0-9]{10}$/.test(code)) {
      input?.setCustomValidity('Code invalide');
      input?.reportValidity();
      setMessage('Le code doit contenir exactement 10 caractères hexadécimaux.', 'error');
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Liaison…';
    }
    setMessage('Association sécurisée de la machine en cours…');

    void invoke<AgentStatus>('link_local_agent', { code }).then((agent) => {
      if (!agent.linked || !agent.machineId || !MACHINE_ID_PATTERN.test(agent.machineId)) throw new Error('agent_link_not_persisted');
      setMessage('Machine associée avec succès.', 'success');
      window.setTimeout(() => void refresh(), 400);
    }).catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error')).finally(() => {
      if (button) {
        button.disabled = false;
        button.textContent = 'Relier cette machine';
      }
      if (input) input.value = '';
    });
  });
};

const verifyAgentSetup = async (): Promise<void> => {
  const agent = await invoke<AgentStatus>('local_agent_status');
  if (!agent.installed) throw new Error('agent_not_installed');
  setMessage('Service GPUbnb installé. Créez ou collez maintenant le code de liaison.', 'success');
};

const handleSetupResult = async (result: string): Promise<void> => {
  if (result === 'isolation_verified') {
    setMessage('Isolation matérielle vérifiée.', 'success');
    return;
  }
  if (result === 'storage_verified') {
    setMessage('Stockage locataire isolé vérifié.', 'success');
    return;
  }
  if (result === 'network_verified') {
    setMessage('Filtrage réseau locataire vérifié.', 'success');
    return;
  }
  if (result === 'agent_setup_completed') {
    await verifyAgentSetup();
    return;
  }
  if (result === 'agent_started') {
    const agent = await invoke<AgentStatus>('local_agent_status');
    if (!agent.running) throw new Error('agent_command_failed');
    setMessage('Service GPUbnb démarré. Vérification en cours…', 'success');
    return;
  }
  if (result === 'open_secure_pairing') {
    setMessage('Ouvrez GPUbnb dans le navigateur pour créer le code.', 'success');
    return;
  }
  throw new Error('agent_command_failed');
};

const bindActions = (status: HostStatus): void => {
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
  document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
    void invoke('request_publish')
      .then(() => void refresh())
      .catch(() => setMessage('Activation refusée : une protection obligatoire manque.', 'error'));
  });

  document.querySelectorAll<HTMLButtonElement>('.create-listing').forEach((button) => button.addEventListener('click', () => {
    const gpuUuid = button.dataset.gpuUuid;
    const machineId = status.agent.machineId;
    const baseUrl = status.pairing.browserUrl;
    if (!gpuUuid || !machineId || !baseUrl) {
      setMessage('Connectez d’abord cette machine à votre compte.', 'error');
      return;
    }
    const target = listingUrl(baseUrl, machineId, gpuUuid);
    if (!target) {
      setMessage('La création a été bloquée car les données de la machine sont invalides.', 'error');
      return;
    }
    openOfficialUrl(target, 'Ouverture de l’annonce préremplie.');
  }));

  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const actionId = button.dataset.action;
    if (!actionId) return;
    if (actionId === 'account') {
      const target = status.pairing.browserUrl ? officialUrl(status.pairing.browserUrl) : null;
      if (!target) {
        setMessage('L’adresse officielle de connexion est invalide ou absente.', 'error');
        return;
      }
      openOfficialUrl(target, 'Le site officiel GPUbnb a été ouvert.');
      return;
    }
    button.disabled = true;
    void invoke<string>('run_setup_action', { actionId })
      .then((result) => handleSetupResult(result))
      .then(() => window.setTimeout(() => void refresh(), 700))
      .catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error'))
      .finally(() => { button.disabled = false; });
  }));
};

async function refresh(): Promise<void> {
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  app.innerHTML = '<main class="loading"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';
  try {
    const selectedProfileId = MINING_CATALOG.find((entry) => entry.symbol === selectedMiningCoin)?.profileId;
    const [status, mining, installation, miningConfiguration, telemetry, thermalSafety] = await Promise.all([
      invoke<HostStatus>('host_status'),
      invoke<MiningRuntimeStatus>('mining_runtime_status')
        .then((runtime): MiningRuntimeRead => ({ status: runtime, error: null }))
        .catch((error: unknown): MiningRuntimeRead => ({ status: null, error: String(error) })),
      (() => {
        const profileId = MINING_CATALOG.find((entry) => entry.symbol === selectedMiningCoin)?.profileId;
        if (!profileId) return Promise.resolve<MinerInstallationRead>({ status: null, error: 'miner_profile_not_integrated' });
        return invoke<MinerInstallationStatus>('approved_miner_status', { profileId })
          .then((value): MinerInstallationRead => ({ status: value, error: null }))
          .catch((error: unknown): MinerInstallationRead => ({ status: null, error: String(error) }));
      })(),
      invoke<MiningConfigurationView>('mining_configuration_get').catch(() => null),
      selectedProfileId
        ? invoke<MiningTelemetry>('mining_telemetry_status', { profileId: selectedProfileId }).catch(() => null)
        : Promise.resolve(null),
      invoke<MiningThermalSafety>('mining_thermal_safety_status').catch(() => null),
    ]);
    const progress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const online = status.lifecycle === 'online';
    const stopped = status.lifecycle === 'emergency_stopped';
    const sidebar = `<aside class="sidebar"><div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Location et minage séparés</small></div></div>
      <nav class="app-navigation" aria-label="Sections principales"><button class="${activeView === 'host' ? 'active' : ''}" data-view="host"><span>01</span><div><strong>GPUbnb</strong><small>Préparation et location</small></div></button>
      <button class="${activeView === 'mining' ? 'active' : ''}" data-view="mining"><span>02</span><div><strong>Minage</strong><small>Cryptos et rendement</small></div></button></nav></aside>`;
    const hostPage = `<section class="content"><header class="topbar"><div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre machine est disponible.' : 'Préparez cet ordinateur.'}</h1><p class="lead">Cette page gère uniquement la préparation sécurisée et la location GPUbnb.</p></div>
      <div class="status-stack"><span class="status-pill ${status.lifecycle}">${lifecycleLabel(status.lifecycle)}</span><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div></header>
      ${stopped ? '<section class="alert-card danger"><strong>Arrêt d’urgence actif</strong></section>' : ''}
      <section class="progress-card"><div class="progress-heading"><div><p class="eyebrow">État de préparation</p><h2>${escapeHtml(status.summary)}</h2></div><strong>${progress}%</strong></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></section>
      ${renderPairing(status)}${renderGpuInventory(status)}<p id="action-status" class="action-status" aria-live="polite"></p><ul class="checks">${renderChecks(status.checks)}</ul>
      <div class="actions"><button id="refresh" class="secondary large">Revérifier</button><button id="publish" class="primary large" ${status.ready && !stopped && !online ? '' : 'disabled'}>${online ? 'Machine déjà en ligne' : 'Mettre en ligne'}</button></div></section>`;
    const miningPage = `<section class="content mining-page"><header class="topbar"><div><p class="eyebrow">Minage personnel</p><h1>Choisissez une cryptomonnaie.</h1><p class="lead">Le minage personnel est indépendant de la publication GPUbnb. Le rendement sera calculé à partir du test réel de cette machine.</p></div>
      <div class="status-stack"><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div></header>
      ${stopped ? '<section class="alert-card danger"><strong>Arrêt d’urgence actif — redémarrage interdit.</strong></section>' : ''}
      ${renderMiningCatalog()}${(() => {
        const coin = MINING_CATALOG.find((entry) => entry.symbol === selectedMiningCoin);
        return coin?.profileId
          ? renderMiningRuntime(coin, mining, installation, miningConfiguration, telemetry, thermalSafety)
          : `<section class="mining-runtime unavailable"><div><p class="eyebrow">${escapeHtml(selectedMiningCoin)}</p><h2>Profil sélectionné</h2></div><div class="mining-controls"><button class="primary" disabled>Démarrer le minage</button></div></section>`;
      })()}<p id="action-status" class="action-status" aria-live="polite"></p></section>`;
    app.innerHTML = `<main class="layout">${sidebar}${activeView === 'host' ? hostPage : miningPage}</main>`;
    bindNavigation();
    bindCatalog();
    if (activeView === 'host') {
      bindPairing();
      bindActions(status);
    } else {
      const coin = MINING_CATALOG.find((entry) => entry.symbol === selectedMiningCoin);
      if (coin?.profileId) bindMining(coin, mining, installation, miningConfiguration);
    }
    if (activeView === 'mining' && (mining.status?.process.status === 'running' || thermalSafety?.latched)) {
      refreshTimer = window.setTimeout(() => void refresh(), 5_000);
    }
  } catch (error: unknown) {
    app.innerHTML = `<main class="error-state"><h1>Votre ordinateur reste protégé.</h1><p>${escapeHtml(String(error))}</p><button id="retry" class="primary large">Relancer</button></main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

if (readOnboardingState().introductionCompleted) void refresh();
else {
  app.innerHTML = '<main class="welcome-shell"><section class="welcome-card"><div class="brand"><span class="brand-mark">G</span><strong>GPUbnb Host</strong></div><h1>Préparons votre ordinateur.</h1><p>La configuration reste bloquée tant qu’une protection obligatoire manque.</p><button id="start-onboarding" class="primary large">Commencer</button></section></main>';
  document.querySelector<HTMLButtonElement>('#start-onboarding')?.addEventListener('click', () => {
    completeIntroduction();
    void refresh();
  });
}
