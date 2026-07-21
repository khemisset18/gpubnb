# Frontend Premium vert/noir

Cette version remplace l'ancienne page minimale par une interface responsive inspirée de l'identité visuelle GPUbnb : noir profond, vert néon, terminal de vérification, marketplace, sécurité, métriques et aperçu tableau de bord.

La logique existante est conservée :

- connexion Phantom ;
- authentification par signature ;
- chargement des annonces depuis l'API ;
- création d'une réservation d'une heure ;
- transaction escrow et confirmation du dépôt ;
- statut Devnet/Mainnet reçu depuis `/health`.

Les boutons qui représentent des modules non encore connectés affichent explicitement qu'ils seront disponibles dans une étape ultérieure. Aucun faux chiffre de production n'est présenté.
