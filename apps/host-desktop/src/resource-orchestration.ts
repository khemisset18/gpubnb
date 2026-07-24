import './resource-orchestration.css';

export type ResourceMode = 'offline' | 'idle' | 'mining' | 'stopping_miner' | 'rental' | 'recovering';

export type ResourceAutomationView = {
  mode: ResourceMode;
  label: string;
  detail: string;
  activeStep: number;
};

export const resourceAutomationView = (
  lifecycle: 'setup_required' | 'ready' | 'online' | 'emergency_stopped',
): ResourceAutomationView => {
  if (lifecycle === 'emergency_stopped') {
    return {
      mode: 'offline',
      label: 'Automatisation arrêtée',
      detail: 'Le mineur et les locations restent bloqués jusqu’à une nouvelle validation de sécurité.',
      activeStep: 0,
    };
  }

  if (lifecycle === 'online') {
    return {
      mode: 'idle',
      label: 'GPU disponible',
      detail: 'GPUbnb attend une réservation. Le minage optionnel pourra utiliser le GPU uniquement lorsqu’il est libre.',
      activeStep: 1,
    };
  }

  return {
    mode: 'offline',
    label: 'Automatisation en attente',
    detail: 'La protection de l’hôte doit être entièrement validée avant de piloter un mineur ou une location.',
    activeStep: 0,
  };
};

export const renderResourceAutomation = (view: ResourceAutomationView): string => `
  <section class="resource-automation" aria-labelledby="resource-automation-title">
    <div class="automation-heading">
      <div>
        <p class="eyebrow">Utilisation intelligente du GPU</p>
        <h2 id="resource-automation-title">Location prioritaire, minage optionnel</h2>
      </div>
      <span class="automation-status ${view.mode}">${view.label}</span>
    </div>
    <p class="automation-detail">${view.detail}</p>
    <ol class="automation-flow">
      <li class="${view.activeStep === 1 ? 'active' : ''}">
        <span>1</span>
        <div><strong>GPU libre</strong><small>Lancer le mineur seulement s’il est activé et configuré.</small></div>
      </li>
      <li class="${view.activeStep === 2 ? 'active' : ''}">
        <span>2</span>
        <div><strong>Réservation reçue</strong><small>Arrêter le mineur et attendre sa fin propre. En cas d’échec, la location reste bloquée.</small></div>
      </li>
      <li class="${view.activeStep === 3 ? 'active' : ''}">
        <span>3</span>
        <div><strong>Location isolée</strong><small>Démarrer uniquement l’environnement temporaire sécurisé du locataire.</small></div>
      </li>
      <li class="${view.activeStep === 4 ? 'active' : ''}">
        <span>4</span>
        <div><strong>Location terminée</strong><small>Détruire l’espace temporaire, revérifier le GPU, puis relancer le mineur si autorisé.</small></div>
      </li>
    </ol>
    <p class="automation-guard">Priorité absolue : sécurité → arrêt propre → location → nettoyage → reprise optionnelle.</p>
  </section>`;
