

: consigne,
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!reponse.ok) throw new Error(`API Anthropic ${reponse.status}`);
  const data = await reponse.json();
  return (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/* ---------- Classement par IA (dernier recours) ---------- */
const CATEGORIES_VALIDES = ["client", "prospect", "compta", "technique", "demarchage", "a_classer"];

async function classerParIA(mail) {
  if (!CLE_IA) return null;

  const consigne = `Tu classes les mails recus par le Domaine de la Cour des Lys, un lieu de reception en Normandie (mariages, seminaires, hebergement).

Reponds UNIQUEMENT par un objet JSON, sans texte autour, sans balises markdown :
{"categorie":"...","dossier":"...","analyse":"..."}

categorie doit valoir exactement l'une de ces valeurs :
- "prospect"   : quelqu'un se renseigne, demande un tarif, une visite, une disponibilite, envoie un formulaire de demande
- "client"     : echange avec un couple ou une entreprise dont l'evenement est deja reserve (organisation, rooming list, plan de table, acompte, J-3 mois...)
- "compta"     : facture, devis fournisseur, releve, prelevement, taxe, banque, expert-comptable, assurance
- "technique"  : notification automatique d'un outil, code de verification, message vocal, avis Google, maintenance
- "demarchage" : prospection commerciale entrante, newsletter, offre de service, referencement
- "a_classer"  : impossible de trancher

dossier : le nom du couple ou de la societe concernee si tu peux l'identifier dans le message, sinon null.
analyse : une phrase courte en francais expliquant ta decision, sans accent obligatoire.`;

  const message = `Expediteur : ${mail.expediteur || "(inconnu)"} <${mail.expediteur_email || "?"}>
Objet : ${mail.objet || "(sans objet)"}

Message :
${(mail.corps || mail.extrait || "(vide)").slice(0, 2000)}`;

  try {
    const texte = (await appelerClaude(MODELE_IA, consigne, message, 300))
      .replace(/```json|```/g, "")
      .trim();

    const avis = JSON.parse(texte);
    if (!CATEGORIES_VALIDES.includes(avis.categorie)) return null;

    compteurIA++;
    return {
      categorie: avis.categorie,
      dossier: avis.dossier || (avis.categorie === "compta" ? "Compta" : null),
      analyse: `${avis.analyse || "Classe par lecture du message"} (IA)`,
    };
  } catch (e) {
    console.log("  ! IA : ", e.message, "— classement par regles conserve.");
    return null;
  }
}

/* ---------- Redaction d'un brouillon de reponse ---------- */
async function redigerBrouillon(mail) {
  const consigne = `Tu rediges un brouillon de reponse a un mail recu par le Domaine de la Cour des Lys, un lieu de reception en Normandie (mariages, seminaires, hebergement). Ce brouillon sera relu, modifie et valide par un membre de l'equipe avant tout envoi.

Regles imperatives :
- Reponds en francais, vouvoiement, ton chaleureux et professionnel, sans emphase excessive.
- Sois concis : quelques phrases suffisent le plus souvent.
- N'invente JAMAIS une information factuelle : prix, date, disponibilite, nom, condition. Si la reponse en depend, ecris [A COMPLETER : ce qu'il faut verifier] a l'endroit voulu.
- Ne confirme jamais une reservation, une remise ou un engagement : propose, ou signale [A VERIFIER].
- Termine exactement par : "${SIGNATURE}"
- Reponds UNIQUEMENT avec le texte du mail, sans objet, sans balises, sans commentaire autour.`;

  let fiche = "";
  const connu = mail.expediteur_email && ANNUAIRE.get((mail.expediteur_email || "").toLowerCase());
  if (connu) {
    fiche = `\n\nFiche du dossier connu chez nous :
- Nom : ${connu.nom || connu.contact || "?"}
- Statut : ${connu.statut || "?"}
- Projet : ${connu.titre_projet || "?"}
- Date de l'evenement : ${connu.date_debut || "?"}`;
  }

  const message = `Mail recu, auquel il faut repondre :
Expediteur : ${mail.expediteur || "(inconnu)"} <${mail.expediteur_email || "?"}>
Objet : ${mail.objet || "(sans objet)"}
Categorie CDL : ${mail.categorie || "?"} · Dossier : ${mail.dossier || "aucun"}${fiche}

Corps du message :
${(mail.corps || mail.extrait || "(vide)").slice(0, 3000)}`;

  return appelerClaude(MODELE_REDACTION, consigne, message, 1000);
}

/* ---------- Traitement des reponses (brouillons + envois) ---------- */
let reponsesEnCours = 0;

async function traiterReponses() {
  if (!tableReponsesOK || verrouPose(reponsesEnCours)) return;
  reponsesEnCours = Date.now();
  try {
    const { data, error } = await supabase
      .from("reponses")
      .select("*")
      .in("statut", ["brouillon_demande", "a_envoyer"])
      .order("cree_le", { ascending: true })
      .limit(10);
    if (error) { console.log("  ! Lecture reponses :", error.message); return; }

    for (const rep of data || []) {
      if (rep.statut === "brouillon_demande") await faireBrouillon(rep);
      else if (rep.statut === "a_envoyer") await faireEnvoi(rep);
    }
  } catch (e) {
    console.log("  ! Traitement reponses :", e.message);
  } finally {
    reponsesEnCours = 0;
  }
}

/* Reserve une ligne (evite tout double traitement) : ne continue que si
   la ligne etait encore dans le statut attendu. */
async function reserver(rep, statutAttendu, statutEnCours) {
  const { data, error } = await supabase
    .from("reponses")
    .update({ statut: statutEnCours })
    .eq("id", rep.id)
    .eq("statut", statutAttendu)
    .select();
  return !error && data && data.length > 0;
}

async function majReponse(id, champs) {
  const { error } = await supabase.from("reponses").update(champs).eq("id", id);
  if (error) console.log(`  ! Mise a jour reponse ${id} :`, error.message);
}

async function faireBrouillon(rep) {
  if (!(await reserver(rep, "brouillon_demande", "brouillon_en_cours"))) return;
  if (!CLE_IA) {
    await majReponse(rep.id, { statut: "erreur", erreur: "Pas de cle ANTHROPIC_API_KEY sur le serveur." });
    return;
  }
  try {
    const { data: mail } = await supabase
      .from("mails").select("*").eq("id", rep.mail_id).single();
    if (!mail) throw new Error("mail introuvable en base");

    const brouillon = await redigerBrouillon(mail);
    if (!brouillon) throw new Error("reponse vide de l'IA");

    await majReponse(rep.id, { corps: brouillon, statut: "brouillon_pret", erreur: null });
    console.log(`  + Brouillon redige pour ${rep.destinataire} (reponse ${rep.id}).`);
  } catch (e) {
    console.log(`  ! Brouillon ${rep.id} :`, e.message);
    await majReponse(rep.id, { statut: "erreur", erreur: "Brouillon impossible : " + e.message });
  }
}

async function faireEnvoi(rep) {
  if (!(await reserver(rep, "a_envoyer", "envoi_en_cours"))) return;
  try {
    const dest = (rep.destinataire || "").trim();
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(dest)) throw new Error("adresse destinataire invalide : " + dest);
    if (!rep.corps || !rep.corps.trim()) throw new Error("corps du message vide");

    let entetes = {};
    if (rep.mail_id && colonneMessageIdOK) {
      const { data: mail } = await supabase
        .from("mails").select("message_id").eq("id", rep.mail_id).single();
      if (mail && mail.message_id) {
        entetes = { inReplyTo: mail.message_id, references: mail.message_id };
      }
    }

    await smtp.sendMail({
      from: `"${EXPEDITEUR_NOM}" <${process.env.MAIL_UTILISATEUR}>`,
      to: dest,
      subject: rep.objet || "Re : votre message",
      text: rep.corps,
      ...entetes,
    });

    await majReponse(rep.id, { statut: "envoye", envoye_le: new Date(), erreur: null });
    console.log(`  + Reponse ${rep.id} envoyee a ${dest}.`);
  } catch (e) {
    console.log(`  ! Envoi ${rep.id} :`, e.message);
    await majReponse(rep.id, { statut: "erreur", erreur: "Envoi impossible : " + e.message });
  }
}

/* ---------- Classement par regles ---------- */
function classer(mail) {
  const de = (mail.expediteur_email || "").toLowerCase();
  const nomDe = (mail.expediteur || "").toLowerCase();
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.corps || mail.extrait || "").toLowerCase();
  const tout = objet + " " + corps;

  const libelle = (d) => {
    const base = d.nom || d.contact || "Dossier";
    return d.date_debut ? `${base} · ${d.date_debut.slice(0, 4)}` : base;
  };

  /* 0. Mail envoye par le Domaine lui-meme (copie a soi, accuse) */
  if (de.includes("domainedelacourdeslys")) {
    return { categorie: "technique", dossier: null,
      analyse: "Message emis par le Domaine — copie interne" };
  }

  /* 1. PLATEFORME d'apport d'affaires — traitee en premier :
        ce sont des leads, pas des notifications techniques */
  if (PLATEFORMES.some((p) => de.includes(p))) {
    // les vraies newsletters commerciales des plateformes restent du demarchage
    if (/newsletter|check-list|nouveaut|webinar|astuce|conseil du mois|business/.test(objet)) {
      return { categorie: "demarchage", dossier: null,
        analyse: "Communication commerciale de la plateforme — sans suite" };
    }
    const vraie = adresseDansCorps(mail.corps || mail.extrait);
    const suite = vraie && ANNUAIRE.get(vraie);
    if (suite) {
      return { categorie: suite.statut === "client" ? "client" : "prospect",
        dossier: libelle(suite),
        analyse: `Via plateforme — dossier reconnu (${vraie})` };
    }
    return { categorie: "prospect", dossier: "Nouvelle demande",
      analyse: vraie
        ? `Nouvelle demande via plateforme — contact : ${vraie}`
        : "Nouvelle demande via plateforme — a rattacher a un dossier" };
  }

  /* 2. TECHNIQUE : outils, notifications, codes — avant tout le reste */
  const OUTILS = ["render.com", "neon.tech", "supabase", "github", "vercel",
    "cloudflare", "ovh.com", "ovh.net", "anthropic", "claude.ai", "mammotion",
    "3douest", "apple.com", "google.com", "microsoft", "3cx", "search-console",
    "wordpress", "wix.com", "squarespace"];
  const CODES = /code de verification|verification code|2fa|double authentification|reinitialisation|password reset|verify your device|connexion detectee|message vocal|appel manque|memory limit|deploy|mot de passe|password|securite de votre compte|sécurité de votre compte|verifier votre identite|vérifier votre identité/;
  // v6 : les codes/notifications ne sont cherches que dans l'objet — un mail
  // de client qui *cite* un mot technique dans son texte n'est plus happe ici
  if (OUTILS.some((m) => de.includes(m)) || CODES.test(objet)) {
    return { categorie: "technique", dossier: null,
      analyse: "Notification technique — aucune action commerciale" };
  }

  /* 3. DEMARCHAGE : sollicitations commerciales — avant les regles metier */
  const DEMARCHAGE_DE = ["sistrix", "dolcevita", "dolce-vita", "le-guide",
    "guerveur", "guinguette", "athezza", "mjt.lu", "mailjet", "sendinblue",
    "brevo", "studio-jfg", "monatelier", "romantictourist", "qweeby"];
  const DEMARCHAGE_TXT = /se desinscrire|desinscription|unsubscribe|votre visibilite|referencement|newsletter|webinar|nous serions ravis de|offre speciale|decouvrez notre|augmentez vos reservations|mettre en images vos|economisez|économisez|remises sur quantit|offre exclusive|ventes flash|promotions du/;
  if (DEMARCHAGE_DE.some((m) => de.includes(m) || nomDe.includes(m)) || DEMARCHAGE_TXT.test(tout)) {
    return { categorie: "demarchage", dossier: null,
      analyse: "Sollicitation commerciale externe — sans suite" };
  }

  /* 4. Expediteur connu : la reponse la plus fiable — consultee AVANT la
        regle compta (v6) : une cliente qui ecrit depuis sa banque ou son
        entreprise reste une cliente, pas une facture */
  const connu = ANNUAIRE.get(de);
  if (connu) {
    if (connu.statut === "client") {
      return { categorie: "client", dossier: libelle(connu),
        analyse: `Client identifie — ${connu.titre_projet || "dossier en cours"}` };
    }
    if (connu.statut === "prospect") {
      return { categorie: "prospect", dossier: libelle(connu),
        analyse: `Prospect identifie — ${connu.titre_projet || "demande en cours"}` };
    }
    return { categorie: "prospect", dossier: libelle(connu),
      analyse: "Ancien contact (dossier perdu) qui reecrit — piste a requalifier" };
  }

  /* 5. COMPTA par expediteur : banques, tresor, organismes — mais pas si le
        mail parle manifestement d'un evenement chez nous */
  const COMPTA_DE = ["payfip", "sips-services", "credit-agricole", "creditagricole",
    "ca-normandie", "banque", "urssaf", "impots.gouv", "dgfip", "amazon.fr",
    "amazon.com", "sage", "cegid", "pennylane", "qonto", "stripe", "anett"];
  if (COMPTA_DE.some((m) => de.includes(m) || nomDe.includes(m))) {
    if (/votre evenement|votre événement|votre mariage|votre seminaire|votre séminaire|devis pour votre|au domaine de la cour des lys|demande de devis|salle de mariage|salle de seminaire|salle de séminaire/.test(tout)) {
      return { categorie: "prospect", dossier: "A rattacher",
        analyse: "Expediteur type banque mais le mail parle d'un evenement chez nous — a rattacher" };
    }
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable (banque, tresor public ou fournisseur)" };
  }

  /* 6. COMPTA par contenu — sans le mot "avoir", et jamais si c'est une
        demande entrante (devis, salle) qui parle par hasard d'argent */
  if (!/demande de devis|salle de mariage|salle de seminaire|salle de séminaire|demande de renseignement/.test(tout)
    && /factur|releve bancaire|virement|prelevement|echeance de paiement|taxe de sejour|urssaf|impot|tva|comptabilit|declaration fiscale|ticket de paiement|note de frais|devis n°|avis de paiement/.test(tout)) {
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable ou taxe — a rapprocher de l'exercice" };
  }

  /* 7. Document d'organisation */
  if (/rooming|plan de table|deroul[ée]|liste des invit|etat des lieux|caution|attestation d'assurance/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Document d'organisation — expediteur inconnu, dossier a rattacher" };
  }

  /* 8. Demande entrante */
  if (/demande d'information|demande d'info|demande de renseignement|demande de devis|salle de mariage|salle de seminaire|salle de séminaire|disponibilit|votre tarif|vos tarifs|visite|brochure|formulaire de demande|nouvelle demande/.test(tout)) {
    return { categorie: "prospect", dossier: "Nouvelle demande",
      analyse: "Demande entrante (renseignements, disponibilites, tarifs)" };
  }

  /* 9. Suivi de dossier */
  if (/votre mariage|votre evenement|votre week-end|votre sejour|acompte|solde|contrat|confirmation d'option|j - ?\d|j-\d/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Suivi de dossier — expediteur inconnu, a rattacher" };
  }

  return { categorie: "a_classer", dossier: null,
    analyse: "Non reconnu automatiquement — a classer manuellement" };
}

/* ---------- Fabrique de devis (demandes deposees dans CDL) ----------
   L'equipe decrit le devis en francais dans l'onglet Finance ; Claude
   le monte depuis la bibliotheque d'articles et le range en BROUILLON.
   Les prix des articles du catalogue viennent TOUJOURS de la base,
   jamais du modele. */
let demandesEnCours = 0;
const arrondi2 = (x) => Math.round(x * 100) / 100;

function calculLigneDevis(l) {
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const q = num(l.quantite) || 0;
  const coef = q * (1 - (num(l.remisePct) || 0) / 100);
  let ht10 = 0, ht20 = 0;
  if (l.tvaMode === "mixte") { ht10 = num(l.partHT10) * coef; ht20 = num(l.partHT20) * coef; }
  else if (String(l.tva) === "10") ht10 = num(l.prixHT) * coef;
  else ht20 = num(l.prixHT) * coef;
  return { ht: arrondi2(ht10 + ht20), ttc: arrondi2(ht10 * 1.1 + ht20 * 1.2) };
}
function totalTTCDevis(lignes, avecOptions) {
  let t = 0;
  for (const l of lignes || []) { if (l.enOption && !avecOptions) continue; t += calculLigneDevis(l).ttc; }
  return arrondi2(t);
}

async function prochainNumeroDevisServeur() {
  const an = new Date().getFullYear();
  let max = an === 2026 ? 117 : 0;
  const { data } = await supabase.from("devis").select("donnees").limit(2000);
  for (const d of data || []) {
    const m = /^DEV-(\d{4})-(\d+)$/.exec(((d.donnees || {}).numero) || "");
    if (m && Number(m[1]) === an) max = Math.max(max, Number(m[2]));
  }
  return `DEV-${an}-${String(max + 1).padStart(4, "0")}`;
}

async function fabriquerDevis(dem) {
  const don = dem.donnees || {};
  try {
    let ev = null;
    if (don.evenementId) {
      const { data } = await supabase.from("evenements").select("donnees").eq("id", don.evenementId).single();
      ev = data ? data.donnees : null;
    }
    /* Mode AJUSTEMENT : la demande vise un devis existant, on le recharge. */
    let devisExistant = null;
    if (don.devisId) {
      const { data } = await supabase.from("devis").select("donnees").eq("id", don.devisId).single();
      devisExistant = data ? data.donnees : null;
      if (!devisExistant) throw new Error("le devis a ajuster n'existe plus (" + don.devisId + ")");
    }
    const { data: arts } = await supabase.from("articles").select("donnees").limit(500);
    const articles = (arts || []).map((a) => a.donnees).filter((a) => a && a.actif !== false);
    if (!articles.length) throw new Error("bibliotheque d'articles vide");
    const catalogue = articles.map((a) => ({
      id: a.id, ref: a.reference || "", nom: a.nom, section: a.section, famille: a.famille,
      unite: a.unite, tva: a.tvaMode === "mixte" ? "mixte(10/20)" : a.tva + "%",
      prixHT: a.tvaMode === "mixte" ? `${a.partHT10} a 10% + ${a.partHT20} a 20%` : a.prixHT,
    }));

    const consigne = `Tu prepares des devis pour le Domaine de la Cour des Lys (lieu de receptions en Normandie).
Tu recois la demande de l'equipe, la fiche de l'evenement et le catalogue des prestations.
Reponds UNIQUEMENT par un objet JSON. Commence ta reponse DIRECTEMENT par { sans aucune phrase,
aucune explication, aucun commentaire avant ou apres. Forme attendue :
{
 "titre": "...", "clientele": "prive" ou "professionnel", "nbPersonnes": nombre,
 "prestaDebut": "AAAA-MM-JJ", "prestaHeureDebut": "HH:MM", "prestaFin": "AAAA-MM-JJ", "prestaHeureFin": "HH:MM",
 "ceremonie": "laique" | "religieuse" | "",
 "lignes": [
   { "articleId": "art_...", "quantite": n, "remisePct": 0, "enOption": false, "groupe": "TITRE DE SECTION" },
   { "libre": true, "nom": "...", "description": "...", "prixHT": n, "tva": "10" ou "20", "unite": "personne"|"unite"|"forfait"|"nuit", "quantite": n, "remisePct": 0, "enOption": false, "groupe": "..." }
 ],
 "hypotheses": ["ce que tu as suppose ou n'as pas trouve au catalogue"]
}
Regles imperatives :
- des qu'une prestation existe au catalogue, utilise son articleId — n'invente JAMAIS de prix pour elle ;
- les lignes libres ne servent qu'aux prestations absentes du catalogue (prix 0 si inconnu) ;
- quantite des articles factures "par personne" = nombre de personnes ;
- groupes courts en MAJUSCULES (PRIVATISATION, RESTAURATION, HEBERGEMENTS, VENTES ADDITIONNELLES...) ;
- "en option" uniquement si la demande le presente comme optionnel ou incertain ;
- pour un mariage choisis la privatisation de la bonne saison (estivale mai-sept, mi-saison oct-nov et mars-avril, hivernale dec-fev) ;
- un mariage va TOUJOURS du vendredi 14:00 au dimanche 18:00 : si on te donne un samedi ou un dimanche, prestaDebut = le vendredi de ce week-end ;
- si un devis existant est fourni, tu le MODIFIES : repars de ses lignes telles quelles, applique UNIQUEMENT les changements demandes, et renvoie le devis COMPLET (toutes les lignes, meme celles qui ne changent pas, dans le meme ordre) ;
- hebergements : deux grilles — sans mention d'annee = tarifs 2026-2027 ; suffixe "tarif 2028" = evenement en 2028 ou apres. Choisis la grille selon la date de l'evenement. En semaine (lundi-jeudi), prends les articles "nuit en semaine".`;

    const compacterLigne = (l) => ({
      articleId: l.articleId || undefined, libre: l.articleId ? undefined : true,
      nom: l.nom, description: l.description || undefined, groupe: l.groupe || "",
      unite: l.unite, quantite: l.quantite, remisePct: l.remisePct || 0, enOption: !!l.enOption,
      tva: l.tvaMode === "mixte" ? "mixte" : l.tva, prixHT: l.prixHT, partHT10: l.partHT10 || undefined, partHT20: l.partHT20 || undefined,
    });
    const message = `Demande de l'equipe :
${don.texte || "(vide)"}
${devisExistant ? `
Devis existant a MODIFIER (n'applique que les changements demandes) :
${JSON.stringify({
  titre: devisExistant.titre, clientele: devisExistant.clientele, nbPersonnes: devisExistant.nbPersonnes,
  prestaDebut: devisExistant.prestaDebut, prestaHeureDebut: devisExistant.prestaHeureDebut,
  prestaFin: devisExistant.prestaFin, prestaHeureFin: devisExistant.prestaHeureFin,
  ceremonie: devisExistant.ceremonie, lignes: (devisExistant.lignes || []).map(compacterLigne),
})}
` : ""}
Evenement lie :
${ev ? JSON.stringify({ client: ev.client, categorie: ev.categorie, type: ev.type, dateDebut: ev.dateDebut, dateFin: ev.dateFin, heureDebut: ev.heureDebut, heureFin: ev.heureFin, nbInvites: ev.nbInvites, nbRepas: ev.nbRepas, nbVinHonneur: ev.nbVinHonneur, ceremonie: ev.ceremonie, notesEquipe: ev.notes || "" }) : "(aucun)"}
${ev && ev.notes ? "IMPORTANT : les notes de l'equipe (notesEquipe) viennent du premier contact telephonique — elles priment pour composer les lignes du devis." : ""}

Catalogue :
${JSON.stringify(catalogue)}

Date du jour : ${new Date().toISOString().slice(0, 10)}`;

    const texte = await appelerClaude(MODELE_REDACTION, consigne, message, 3500);
    /* Le modele bavarde parfois autour du JSON : on extrait du premier { au dernier }. */
    const debutJson = texte.indexOf("{");
    const finJson = texte.lastIndexOf("}");
    if (debutJson < 0 || finJson <= debutJson) throw new Error("le modele n'a pas repondu en JSON");
    const json = JSON.parse(texte.slice(debutJson, finJson + 1));

    const parId = new Map(articles.map((a) => [a.id, a]));
    const lignes = [];
    let seq = 0;
    for (const lg of json.lignes || []) {
      const idL = `lg_${Date.now()}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const commun = {
        id: idL, groupe: lg.groupe || "", quantite: Number(lg.quantite) || 1,
        remisePct: Number(lg.remisePct) || 0, enOption: !!lg.enOption,
        dateDebut: "", dateFin: "", heureDebut: "", heureFin: "", afficherDates: false,
      };
      const a = lg.articleId ? parId.get(lg.articleId) : null;
      if (a) {
        lignes.push({ ...commun, articleId: a.id, reference: a.reference || "", nom: a.nom, description: a.description || "",
          unite: a.unite, tvaMode: a.tvaMode === "mixte" ? "mixte" : "simple", tva: a.tva || "20",
          prixHT: a.prixHT || "", partHT10: a.partHT10 || "", partHT20: a.partHT20 || "" });
      } else {
        lignes.push({ ...commun, reference: "", nom: lg.nom || "Prestation à préciser", description: lg.description || "",
          unite: lg.unite || "forfait", tvaMode: "simple", tva: String(lg.tva || "20"),
          prixHT: Number(lg.prixHT) || 0, partHT10: "", partHT20: "" });
      }
    }
    if (!lignes.length) throw new Error("le modele n'a produit aucune ligne");

    const clientele = (json.clientele || (devisExistant && devisExistant.clientele) || "prive") === "professionnel" ? "professionnel" : "prive";
    const famille = clientele === "professionnel" ? "pro" : "mariage";
    const jour = new Date().toISOString().slice(0, 10);
    let debut = json.prestaDebut || (devisExistant && devisExistant.prestaDebut) || (ev && ev.dateDebut) || "";
    let finPresta = json.prestaFin || (devisExistant && devisExistant.prestaFin) || "";
    let heureDebPresta = json.prestaHeureDebut || (devisExistant && devisExistant.prestaHeureDebut) || "";
    let heureFinPresta = json.prestaHeureFin || (devisExistant && devisExistant.prestaHeureFin) || "";
    /* Regle maison : un mariage va TOUJOURS du vendredi 14 h au dimanche 18 h,
       meme si la demande donne le samedi. On recale ici, sans dependre du modele. */
    if (famille === "mariage" && /^\d{4}-\d{2}-\d{2}$/.test(debut)) {
      const t = new Date(debut + "T12:00:00");
      t.setDate(t.getDate() - ((t.getDay() - 5 + 7) % 7));
      debut = t.toISOString().slice(0, 10);
      t.setDate(t.getDate() + 2);
      finPresta = t.toISOString().slice(0, 10);
      heureDebPresta = heureDebPresta || "14:00";
      heureFinPresta = heureFinPresta || "18:00";
    }
    const moins = (dateISO, jours) => { const t = new Date(dateISO + "T12:00:00"); t.setDate(t.getDate() - jours); return t.toISOString().slice(0, 10); };
    const baseSolde = debut || jour;
    const echeances = famille === "mariage"
      ? [{ pct: 30, libelle: "À la signature", date: jour }, { pct: 70, libelle: "Solde — 2 mois avant l'événement", date: moins(baseSolde, 60) }]
      : [{ pct: 50, libelle: "À la signature", date: jour }, { pct: 50, libelle: "Solde — 72 h avant l'événement", date: moins(baseSolde, 3) }];

    /* Ajustement : on garde l'identite du devis (numero, id, date) ; sinon nouveau. */
    const numero = devisExistant ? devisExistant.numero : await prochainNumeroDevisServeur();
    const idDevis = devisExistant ? devisExistant.id : `dv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const devis = {
      ...(devisExistant || {}),
      id: idDevis, evenementId: don.evenementId || (devisExistant && devisExistant.evenementId) || "",
      numero, date: devisExistant ? devisExistant.date : jour, statut: "brouillon", nomModele: "",
      titre: json.titre || (devisExistant && devisExistant.titre) || (don.texte || "Devis").slice(0, 70), famille, clientele,
      client: (ev && ev.client) || (devisExistant && devisExistant.client) || "",
      nbPersonnes: json.nbPersonnes || (devisExistant && devisExistant.nbPersonnes) || (ev && (ev.nbRepas || ev.nbInvites)) || "",
      emailClient: (ev && ev.email) || (devisExistant && devisExistant.emailClient) || "",
      telClient: (ev && ev.telephone) || (devisExistant && devisExistant.telClient) || "",
      prestaDebut: debut, prestaHeureDebut: heureDebPresta,
      prestaFin: finPresta, prestaHeureFin: heureFinPresta,
      ceremonie: json.ceremonie || (devisExistant && devisExistant.ceremonie) || "",
      lignes, echeances: devisExistant && devisExistant.echeances && devisExistant.echeances.length ? devisExistant.echeances : echeances,
      totalTTC: totalTTCDevis(lignes, false), totalTTCAvecOptions: totalTTCDevis(lignes, true),
      noteAssistant: (Array.isArray(json.hypotheses) && json.hypotheses.length
        ? "Hypothèses : " + json.hypotheses.join(" · ")
        : (devisExistant ? "Devis ajusté par l'assistant — à relire avant envoi." : "Devis préparé par l'assistant — à relire avant envoi.")),
    };
    const enreg = { id: idDevis, donnees: devis, modifie_le: new Date().toISOString() };
    const { error: eIns } = devisExistant
      ? await supabase.from("devis").update(enreg).eq("id", idDevis)
      : await supabase.from("devis").insert(enreg);
    if (eIns) throw new Error(eIns.message);
    await supabase.from("demandes_devis").update({
      donnees: { ...don, statut: "fait", devisId: idDevis, numero },
      modifie_le: new Date().toISOString(),
    }).eq("id", dem.id);
    console.log(`Assistant : devis ${numero} ${devisExistant ? "ajuste" : "fabrique"} (${lignes.length} ligne(s), ${devis.totalTTC} € TTC).`);
  } catch (e) {
    console.log("  ! Fabrication devis :", e.message);
    try {
      await supabase.from("demandes_devis").update({
        donnees: { ...don, statut: "erreur", erreur: e.message },
        modifie_le: new Date().toISOString(),
      }).eq("id", dem.id);
    } catch (e2) { /* on retentera au prochain cycle */ }
  }
}

async function traiterDemandesDevis() {
  if (!tableDemandesOK || verrouPose(demandesEnCours) || !CLE_IA) return;
  demandesEnCours = Date.now();
  try {
    const { data } = await supabase.from("demandes_devis").select("*")
      .eq("donnees->>statut", "en_attente").limit(20);
    const attente = data || [];
    for (const dem of attente) await fabriquerDevis(dem);
  } catch (e) {
    console.log("  ! Demandes de devis :", e.message);
  } finally {
    demandesEnCours = 0;
  }
}

/* ---------- Envoi des devis par mail (file envois_mails, deposee par l'equipe) ---------- */
let envoisDevisEnCours = 0;

async function envoyerDevisParMail(env) {
  const don = env.donnees || {};
  try {
    const dest = (don.a || "").trim();
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(dest)) throw new Error("adresse destinataire invalide : " + dest);
    if (!don.corps || !don.corps.trim()) throw new Error("message vide");
    const echap = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    /* Dans la version HTML, le lien du devis s'affiche « Voir votre document »
       au lieu de l'adresse brute (qui reste dans la version texte). */
    const html = '<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#3d3a35;white-space:pre-wrap">'
      + echap(don.corps).replace(/(https?:\/\/[^\s]+)/g, (url) =>
        url.indexOf("/devis/?c=") >= 0
          ? '<a href="' + url + '" style="color:#A0813C;font-weight:600">Voir votre document</a>'
          : '<a href="' + url + '">' + url + "</a>")
      + "</div>";
    await smtp.sendMail({
      from: `"${EXPEDITEUR_NOM}" <${process.env.MAIL_UTILISATEUR}>`,
      to: dest,
      cc: don.cc || undefined,
      bcc: don.cci || undefined,
      subject: don.objet || ("Votre devis " + (don.numero || "")).trim(),
      text: don.corps,
      html,
    });
    await supabase.from("envois_mails").update({
      donnees: { ...don, statut: "envoye", envoyeLe: new Date().toISOString() },
      modifie_le: new Date().toISOString(),
    }).eq("id", env.id);
    /* le devis passe en statut « envoye » */
    if (don.devisId) {
      const { data: dv } = await supabase.from("devis").select("donnees").eq("id", don.devisId).single();
      if (dv && dv.donnees && dv.donnees.statut === "brouillon") {
        await supabase.from("devis").update({
          donnees: { ...dv.donnees, statut: "envoye" },
          modifie_le: new Date().toISOString(),
        }).eq("id", don.devisId);
      }
    }
    console.log(`Devis ${don.numero || don.devisId || "?"} envoye a ${dest}.`);
  } catch (e) {
    console.log("  ! Envoi devis :", e.message);
    try {
      await supabase.from("envois_mails").update({
        donnees: { ...don, statut: "erreur", erreur: "Envoi impossible : " + e.message },
        modifie_le: new Date().toISOString(),
      }).eq("id", env.id);
    } catch (e2) { /* on retentera au prochain cycle */ }
  }
}

async function traiterEnvoisMails() {
  if (!tableEnvoisOK || verrouPose(envoisDevisEnCours)) return;
  envoisDevisEnCours = Date.now();
  try {
    const { data } = await supabase.from("envois_mails").select("*")
      .eq("donnees->>statut", "en_attente").limit(20);
    const attente = data || [];
    for (const env of attente) await envoyerDevisParMail(env);
  } catch (e) {
    console.log("  ! Envois de devis :", e.message);
  } finally {
    envoisDevisEnCours = 0;
  }
}

/* ---------- Redaction des posts reseaux (onglet Reseaux de CDL) ---------- */
let postsEnCours = 0;

const LIGNE_EDITORIALE = `Tu ecris les publications reseaux sociaux du Domaine de la Cour des Lys,
lieu de receptions en Normandie (Thue et Mue, a 20 min de Caen) : granges du XVIIe siecle en pierre
de Caen, cour d'honneur de 1500 m2 avec fontaine, parc de 2,5 hectares, 800 m2 de salles modulables,
82 couchages, privatisation EXCLUSIVE (jamais de groupes croises), accompagnement par Helene
(interlocutrice unique), aucun prestataire impose. Signature de la maison :
« Laissez-vous porter par l'Histoire du lieu, ecrivez la Votre. »
Ton : luxe sobre, chaleureux, narratif, JAMAIS vendeur agressif.
Selon le reseau :
- instagram : emotion mariage, phrases courtes et sensorielles, 1 emoji sobre maximum par paragraphe,
  finir par une adresse douce (« Il reste quelques week-ends en 2027 — ecrivez-nous ») puis 8 a 10 hashtags
  (#mariagenormandie #chateaumariage #mariagecalvados #domainedelacourdeslys + specifiques a la photo) ;
- linkedin : destine aux entreprises (seminaires, journees de cohesion, soirees), chiffres concrets,
  0 a 3 hashtags, appel a contact direct (contact@domainedelacourdeslys.com) ;
- google : 150 a 300 caracteres, mots-cles locaux naturels (mariage Caen, seminaire Calvados, Normandie),
  finir par une invitation a contacter.
Regles imperatives : n'invente JAMAIS un fait, un prix, un nom ou une date ; pas de visage nomme ;
reponds UNIQUEMENT avec le texte du post, sans commentaire autour.`;

/* v8.11 : l'assistant REGARDE la photo (jointe par son adresse publique du bucket
   'reseaux') au lieu de deviner depuis le nom de fichier — le texte doit decrire
   ce que montre reellement l'image. */
const urlPhotoReseau = (chemin) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/public/reseaux/${encodeURIComponent(chemin)}`;

async function redigerPost(row) {
  const don = row.donnees || {};
  try {
    const message = `Reseau : ${don.reseau || "instagram"}
Date de publication prevue : ${don.date || "(libre)"}
Consigne de l'equipe : ${don.consigne || "(aucune — texte au gout de la maison)"}
${don.texte ? `Texte actuel a retravailler :\n${don.texte}` : "(pas encore de texte : redige-le)"}
La photo du post est jointe : appuie le texte sur ce qu'elle montre REELLEMENT
(lieu, lumiere, objets, moment) — n'invente rien qui n'y figure pas.`;
    let texte;
    if (don.chemin) {
      try {
        texte = await appelerClaude(MODELE_REDACTION, LIGNE_EDITORIALE, [
          { type: "image", source: { type: "url", url: urlPhotoReseau(don.chemin) } },
          { type: "text", text: message },
        ], 800);
      } catch (e1) {
        /* photo illisible pour l'API ? on retente sans elle plutot que d'echouer */
        console.log("  ! Photo non jointe (" + e1.message + "), redaction sans image.");
        texte = await appelerClaude(MODELE_REDACTION, LIGNE_EDITORIALE,
          message + `\n(La photo n'a pas pu etre jointe ; son nom de fichier : ${don.chemin})`, 800);
      }
    } else {
      texte = await appelerClaude(MODELE_REDACTION, LIGNE_EDITORIALE, message, 800);
    }
    if (!texte) throw new Error("reponse vide de l'assistant");
    await supabase.from("posts_reseaux").update({
      donnees: { ...don, texte, statut: "brouillon", note: "Rédigé par l'assistant — relisez avant de publier." },
      modifie_le: new Date().toISOString(),
    }).eq("id", row.id);
    console.log(`Post ${don.reseau || "?"} redige (${row.id}).`);
  } catch (e) {
    console.log("  ! Redaction post :", e.message);
    try {
      await supabase.from("posts_reseaux").update({
        donnees: { ...don, statut: "brouillon", note: "L'assistant n'a pas réussi : " + e.message },
        modifie_le: new Date().toISOString(),
      }).eq("id", row.id);
    } catch (e2) { /* prochain cycle */ }
  }
}

async function traiterPostsReseaux() {
  if (!tablePostsOK || verrouPose(postsEnCours) || !CLE_IA) return;
  postsEnCours = Date.now();
  try {
    /* v8.10 : c'est la base qui filtre — avec .limit(50) seul, les posts a rediger
       devenaient invisibles des que photos + posts depassaient 50 lignes (panne du 28/08). */
    const { data } = await supabase.from("posts_reseaux").select("*")
      .eq("donnees->>statut", "a_rediger").limit(20);
    const attente = data || [];
    for (const row of attente) await redigerPost(row);
    await verifierConseils();
  } catch (e) {
    console.log("  ! Posts reseaux :", e.message);
  } finally {
    postsEnCours = 0;
  }
}

/* ---------- Publication Instagram (v9) ----------
   Le bouton « Publier sur Instagram » de la page Reseaux passe le post en
   statut 'a_publier' ; ici on l'envoie vraiment : conteneur puis publication
   via l'API Instagram (compte professionnel @domainedelacourdeslys).
   Le jeton vient de INSTAGRAM_TOKEN (Render) ; il est rafraichi chaque semaine
   et la version fraiche est rangee dans la ligne 'jeton_instagram' de la table
   posts_reseaux (si le client regenere un jeton dans Render, il reprend la main). */
const INSTAGRAM_ID = "17841414847922598";
const JETON_IG_ENV = process.env.INSTAGRAM_TOKEN || "";
const DELAI_GRAPH = 60000;
let jetonIG = null; // { token, rafraichi_le }

async function chargerJetonIG() {
  if (!jetonIG) {
    const { data } = await supabase.from("posts_reseaux").select("donnees").eq("id", "jeton_instagram").maybeSingle();
    if (data && data.donnees && data.donnees.token) jetonIG = data.donnees;
    else jetonIG = { type: "jeton", token: JETON_IG_ENV, rafraichi_le: "" };
  }
  return jetonIG.token;
}

async function sauverJetonIG(token) {
  /* l'id est AUSSI dans donnees : le shim de la page identifie les objets par
     leur champ id — sans lui, un enregistrement depuis la page effacerait la ligne */
  jetonIG = { id: "jeton_instagram", type: "jeton", token, rafraichi_le: new Date().toISOString() };
  await supabase.from("posts_reseaux").upsert(
    { id: "jeton_instagram", donnees: jetonIG, modifie_le: new Date().toISOString() },
    { onConflict: "id" }
  );
}

async function graphIG(chemin, params, methode) {
  const url = new URL(`https://graph.instagram.com/v23.0/${chemin}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { method: methode || "GET", signal: AbortSignal.timeout(DELAI_GRAPH) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (data && data.error) || {};
    const err = new Error(e.error_user_msg || e.message || `API Instagram ${r.status}`);
    err.code = e.code;
    throw err;
  }
  return data;
}

/* Un jeton vit 60 jours : rafraichi une fois par semaine, il ne meurt jamais.
   (Instagram refuse de rafraichir un jeton de moins de 24 h — on reessaie
   simplement au cycle suivant jusqu'a ce que ca passe.) */
async function rafraichirJetonIG() {
  const jeton = await chargerJetonIG();
  if (!jeton) return;
  const age = jetonIG.rafraichi_le ? (Date.now() - new Date(jetonIG.rafraichi_le).getTime()) / 86400000 : Infinity;
  if (age < 7) return;
  try {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", jeton);
    const r = await fetch(url, { signal: AbortSignal.timeout(DELAI_GRAPH) });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.access_token) {
      await sauverJetonIG(data.access_token);
      console.log("Jeton Instagram rafraichi (valable 60 jours).");
    } else if (JETON_IG_ENV && jeton !== JETON_IG_ENV) {
      jetonIG = { type: "jeton", token: JETON_IG_ENV, rafraichi_le: "" };
      console.log("  ! Jeton stocke refuse — repli sur INSTAGRAM_TOKEN de l'environnement.");
    }
  } catch (e) {
    console.log("  ! Rafraichissement jeton Instagram :", e.message);
  }
}

async function publierSurInstagram(row) {
  const don = row.donnees || {};
  const maj = (champs) => supabase.from("posts_reseaux").update({
    donnees: { ...don, ...champs },
    modifie_le: new Date().toISOString(),
  }).eq("id", row.id);
  try {
    if ((don.reseau || "") !== "instagram") throw new Error("seul Instagram est branche pour l'instant");
    if (!don.chemin) throw new Error("pas de photo attachee au post");
    if (!(don.texte || "").trim()) throw new Error("le texte du post est vide");
    const jeton = await chargerJetonIG();
    if (!jeton) throw new Error("pas de jeton Instagram (INSTAGRAM_TOKEN absent)");
    const conteneur = await graphIG(`${INSTAGRAM_ID}/media`, {
      image_url: urlPhotoReseau(don.chemin),
      caption: don.texte,
      access_token: jeton,
    }, "POST");
    if (!conteneur.id) throw new Error("pas d'identifiant de conteneur");
    /* v9.3 : Instagram prepare la photo pendant quelques secondes — publier
       trop vite renvoie « media is not ready ». On attend le feu vert. */
    const pause = (ms) => new Promise((res) => setTimeout(res, ms));
    let pret = false;
    for (let i = 0; i < 12 && !pret; i++) {
      await pause(5000);
      try {
        const etat = await graphIG(String(conteneur.id), { fields: "status_code", access_token: jeton });
        if (etat.status_code === "FINISHED") pret = true;
        else if (etat.status_code === "ERROR") throw new Error("Instagram n'a pas pu préparer la photo (conteneur en erreur)");
      } catch (e3) {
        if (/conteneur en erreur/.test(e3.message)) throw e3;
        /* etat pas encore lisible : on continue d'attendre */
      }
    }
    if (!pret) throw new Error("photo pas prête après 60 s — nouvel essai au prochain créneau");
    const publie = await graphIG(`${INSTAGRAM_ID}/media_publish`, {
      creation_id: conteneur.id,
      access_token: jeton,
    }, "POST");
    let permalien = "";
    try {
      const infos = await graphIG(String(publie.id), { fields: "permalink", access_token: jeton });
      permalien = infos.permalink || "";
    } catch (e2) { /* le lien est un confort, pas une condition */ }
    await maj({ statut: "publie", publieLe: new Date().toISOString().slice(0, 10), permalien, erreurPublication: "", note: "Publié sur Instagram par le lecteur." });
    console.log(`Post publie sur Instagram (${row.id})${permalien ? " -> " + permalien : ""}.`);
  } catch (e) {
    if (e.code === 190 && JETON_IG_ENV && jetonIG && jetonIG.token !== JETON_IG_ENV) {
      /* jeton stocke perime : on repart du jeton de l'environnement, le post reste en file */
      await sauverJetonIG(JETON_IG_ENV);
      jetonIG.rafraichi_le = "";
      console.log("  Jeton Instagram stocke invalide — retour au jeton Render, nouvel essai au prochain cycle.");
      return;
    }
    console.log("  ! Publication Instagram :", e.message);
    await maj({ statut: "brouillon", erreurPublication: "Publication refusée : " + e.message });
  }
}

/* ---------- Conseils de posts (v9.2) ----------
   Le lecteur croise le planning REEL (week-ends libres par mois) avec la ligne
   editoriale et propose 5 idees de posts ciblees. REGLE CLIENT ABSOLUE : les
   disponibilites ne sont JAMAIS publiees — elles servent uniquement, en interne,
   a choisir les themes (« Mariez-vous en janvier »). */
const MOIS_FR = ["janvier", "fevrier", "mars", "avril", "mai", "juin",
  "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];

async function statistiquesPlanning() {
  const { data } = await supabase.from("evenements").select("donnees").limit(3000);
  const evts = (data || []).map((r) => r.donnees || {});
  const OCCUPANTS = ["confirme", "option", "bloque", "termine", "en_cours"];
  const vendredisPris = new Set();
  const semainesParMois = {};
  evts.forEach((e) => {
    if (!e.dateDebut || !OCCUPANTS.includes(e.statut)) return;
    if (e.type === "semaine") {
      const m = e.dateDebut.slice(0, 7);
      semainesParMois[m] = (semainesParMois[m] || 0) + 1;
    } else {
      vendredisPris.add(e.dateDebut.slice(0, 10));
    }
  });
  const lignes = [];
  const stats = {};
  const d = new Date();
  for (let i = 0; i < 280; i++) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 5) continue;
    const iso = d.toISOString().slice(0, 10);
    const m = iso.slice(0, 7);
    stats[m] = stats[m] || { libres: 0, total: 0 };
    stats[m].total++;
    if (!vendredisPris.has(iso)) stats[m].libres++;
  }
  Object.entries(stats).sort().forEach(([m, s]) => {
    lignes.push(`${MOIS_FR[Number(m.slice(5)) - 1]} ${m.slice(0, 4)} : ${s.libres} week-end(s) mariage encore a vendre sur ${s.total}, ${semainesParMois[m] || 0} evenement(s) pro en semaine`);
  });
  return lignes;
}

async function genererConseils() {
  try {
    const lignes = await statistiquesPlanning();
    const consigne = `${LIGNE_EDITORIALE}

MISSION SPECIALE : tu es le conseiller editorial du Domaine. A partir de l'etat
INTERNE du planning ci-dessous, propose exactement 5 idees de posts pour aider a
remplir les periodes creuses (mariages d'hiver, semaines pro vides) et nourrir le
referencement local Google (mariage Caen, seminaire Calvados, Normandie).

REGLE ABSOLUE DE LA MAISON : les textes destines au public ne mentionnent JAMAIS
de disponibilites — ni dates libres, ni nombre de week-ends, ni « il nous reste ».
Uniquement des allusions thematiques (« Mariez-vous en janvier », « Les charmes
d'un mariage en mai »). Les chiffres du planning restent strictement internes.

Reponds UNIQUEMENT avec un tableau JSON de 5 objets :
[{"titre":"...", "reseau":"instagram|linkedin|google",
  "momentPublication":"quand publier et pourquoi ce moment-la",
  "pourquoi":"la raison interne, chiffres du planning autorises ICI seulement",
  "consigne":"consigne prete pour l'assistant redacteur — thematique, sans la moindre mention de disponibilite"}]`;
    const message = `Etat interne du planning (CONFIDENTIEL, ne jamais publier) :
${lignes.join("\n")}
Date du jour : ${new Date().toISOString().slice(0, 10)}.`;
    const texte = await appelerClaude(MODELE_REDACTION, consigne, message, 2500);
    const conseils = JSON.parse(texte.slice(texte.indexOf("["), texte.lastIndexOf("]") + 1));
    if (!Array.isArray(conseils) || !conseils.length) throw new Error("reponse sans conseils");
    await supabase.from("posts_reseaux").upsert({
      id: "conseils_reseaux",
      donnees: { id: "conseils_reseaux", type: "conseils", statut: "pret", genere_le: new Date().toISOString(), conseils },
      modifie_le: new Date().toISOString(),
    }, { onConflict: "id" });
    console.log(`Conseils de posts regeneres (${conseils.length}).`);
  } catch (e) {
    console.log("  ! Conseils de posts :", e.message);
    await supabase.from("posts_reseaux").upsert({
      id: "conseils_reseaux",
      donnees: { id: "conseils_reseaux", type: "conseils", statut: "erreur", genere_le: new Date().toISOString(), erreur: e.message, conseils: [] },
      modifie_le: new Date().toISOString(),
    }, { onConflict: "id" }).catch?.(() => {});
  }
}

async function verifierConseils() {
  const { data } = await supabase.from("posts_reseaux").select("donnees").eq("id", "conseils_reseaux").maybeSingle();
  const dc = (data && data.donnees) || null;
  const age = dc && dc.genere_le ? (Date.now() - new Date(dc.genere_le).getTime()) / 86400000 : Infinity;
  if (!dc || dc.statut === "a_generer" || (dc.statut === "pret" && age > 7)) await genererConseils();
}

/* L'heure du Domaine, pas celle du serveur (Render vit en UTC). */
function maintenantParis() {
  const parts = new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const v = {};
  parts.forEach((x) => { v[x.type] = x.value; });
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}`;
}

let publicationsEnCours = 0;
async function traiterPublications() {
  if (!tablePostsOK || verrouPose(publicationsEnCours) || !JETON_IG_ENV) return;
  publicationsEnCours = Date.now();
  try {
    await rafraichirJetonIG();

    /* 1. Demandes immediates (bouton « Publier sur Instagram »). */
    const { data } = await supabase.from("posts_reseaux").select("*")
      .eq("donnees->>statut", "a_publier").limit(5);
    for (const row of data || []) await publierSurInstagram(row);

    /* 2. Calendrier (v9.1) : les posts Instagram programmes partent tout seuls
       a l'heure dite (heure de Paris). Un creneau manque de plus de 3 jours
       revient en brouillon plutot que de surgir en ligne a contretemps. */
    const paris = maintenantParis();
    const { data: programmes } = await supabase.from("posts_reseaux").select("*")
      .eq("donnees->>statut", "programme").limit(50);
    for (const row of programmes || []) {
      const don = row.donnees || {};
      if ((don.reseau || "") !== "instagram") continue;
      const quand = `${don.date || "9999-12-31"} ${don.heure || "09:00"}`;
      if (quand > paris) continue;
      const retardJours = (Date.now() - new Date(`${don.date}T12:00:00`).getTime()) / 86400000;
      if (retardJours > 3) {
        await supabase.from("posts_reseaux").update({
          donnees: { ...don, statut: "brouillon", erreurPublication: "Créneau manqué (lecteur à l'arrêt ce jour-là ?) — reprogrammez ou publiez à la main." },
          modifie_le: new Date().toISOString(),
        }).eq("id", row.id);
        continue;
      }
      await publierSurInstagram(row);
    }
  } catch (e) {
    console.log("  ! Publications Instagram :", e.message);
  } finally {
    publicationsEnCours = 0;
  }
}

/* ---------- Un cycle de lecture ---------- */
async function cycle() {
  await verifierExtensionsV5();
  await chargerAnnuaire();
  await chargerEvenements();
  await attribuerCodesMaries();

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.MAIL_UTILISATEUR, pass: process.env.MAIL_MOT_DE_PASSE },
    logger: false,
  });

  await client.connect();
  const boite = await client.getMailboxLock("INBOX", { readOnly: true });

  try {
    const { data: etat } = await supabase
      .from("mails_etat").select("dernier_uid").eq("id", 1).single();
    const depuis = (etat && etat.dernier_uid) || 0;

    let dernierUid = depuis;
    let nouveaux = 0;

    for await (const msg of client.fetch(
      { uid: `${depuis + 1}:*` },
      { uid: true, source: true, envelope: true }
    )) {
      if (msg.uid <= depuis) continue;

      const parsed = await simpleParser(msg.source);
      const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};

      /* v8.6 : les mails « tout HTML » deviennent lisibles (balises retirées). */
      let corps = (parsed.text || "").trim();
      if ((!corps || /^<!doctype|^<html/i.test(corps)) && (parsed.html || corps)) {
        corps = String(parsed.html || corps)
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
          .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
      }
      const pieces = [];
      for (const a of parsed.attachments || []) {
        if (!a.filename) continue;
        const piece = { nom: a.filename, type: a.contentType || null, taille: a.size || null };
        if (bucketOK && a.content && (a.size || 0) <= TAILLE_MAX_PJ) {
          const nomSur = a.filename.replace(/[^\w.\-]+/g, "_").slice(-80);
          const chemin = `${msg.uid}/${pieces.length + 1}-${nomSur}`;
          const { error: errPJ } = await supabase.storage.from(BUCKET).upload(chemin, a.content, {
            contentType: a.contentType || "application/octet-stream",
            upsert: true,
          });
          if (!errPJ) piece.chemin = chemin;
          else console.log(`  ! Piece jointe '${a.filename}' non rangee : ${errPJ.message}`);
        }
        pieces.push(piece);
      }

      const mail = {
        uid_imap: msg.uid,
        date_reception: parsed.date || (msg.envelope && msg.envelope.date) || new Date(),
        expediteur: from.name || null,
        expediteur_email: (from.address || "").toLowerCase() || null,
        objet: parsed.subject || "(sans objet)",
        extrait: corps ? corps.slice(0, 400) : null,
        corps: corps || null,
        pieces_jointes: pieces,
        lu: false,
        traite: false,
      };
      if (colonneMessageIdOK) mail.message_id = parsed.messageId || null;

      let { categorie, dossier, analyse } = classer(mail);

      // les regles n'ont rien reconnu : on demande son avis a l'IA
      if (categorie === "a_classer") {
        const avis = await classerParIA(mail);
        if (avis) ({ categorie, dossier, analyse } = avis);
      }

      mail.categorie = categorie;
      mail.dossier = dossier;
      mail.analyse = analyse;
      if (pieces.length) {
        mail.analyse += ` · ${pieces.length} piece(s) jointe(s) : ${pieces.map((p) => p.nom).join(", ")}`;
      }

      /* v8.7 : un document reconnu coche la fiche de l'evenement tout seul. */
      try {
        const coches = await cocherDocumentsFiche(mail, pieces.map((p) => p.nom || ""));
        if (coches && coches.length) mail.analyse += ` · coché dans la fiche : ${coches.join(", ")}`;
      } catch (e) { /* la coche ne doit jamais bloquer la lecture */ }

      const { error } = await supabase
        .from("mails").upsert(mail, { onConflict: "uid_imap" });

      if (error) {
        console.log(`  ! Erreur ecriture UID ${msg.uid} : ${error.message}`);
      } else {
        nouveaux++;
        console.log(`  + [${categorie}${dossier ? " / " + dossier : ""}] ${mail.expediteur || mail.expediteur_email} — ${mail.objet}`);
      }

      if (msg.uid > dernierUid) dernierUid = msg.uid;
    }

    await supabase.from("mails_etat").upsert({
      id: 1,
      dernier_uid: dernierUid,
      derniere_verif: new Date(),
    });

    console.log(nouveaux
      ? `Cycle termine : ${nouveaux} nouveau(x) mail(s), dernier UID ${dernierUid}${compteurIA ? `, dont ${compteurIA} classe(s) par l'IA` : ""}.`
      : `Cycle termine : rien de nouveau (dernier UID ${dernierUid}).`);
    compteurIA = 0;
  } finally {
    boite.release();
    await client.logout();
  }
}

/* ---------- Boucle ---------- */
(async () => {
  console.log("CDL — Lecteur de boite mail v9.3 (LECTURE SEULE cote IMAP) demarre.");
  console.log(`Boite : ${process.env.MAIL_UTILISATEUR} · Serveur : ${process.env.IMAP_HOST}`);
  console.log(`Verification toutes les ${FREQ / 60000} minute(s) · reponses et demandes de devis relevees toutes les 30 s.`);
  console.log(CLE_IA
    ? `Classement par IA actif (${MODELE_IA}) en secours des regles · brouillons rediges par ${MODELE_REDACTION}.`
    : "Classement par regles seules (pas de cle ANTHROPIC_API_KEY) — brouillons IA indisponibles.");
  console.log(`Envoi SMTP : ${SMTP_HOST}:${SMTP_PORT} (uniquement les reponses validees dans CDL).`);

  console.log(`Sauvegarde automatique : le dimanche vers 20h (heure fr.) par mail a ${SAUVEGARDE_DEST}.`);

  const boucle = async () => {
    try {
      await cycle();
    } catch (e) {
      console.log("Erreur cycle :", e.message, "— nouvel essai au prochain cycle.");
      if (e.responseText) console.log("  Reponse serveur :", e.responseText);
    }
    await verifierSauvegarde();
  };

  await boucle();
  setInterval(boucle, FREQ);
  setInterval(traiterReponses, 30000);
  setInterval(traiterDemandesDevis, 30000);
  setInterval(traiterEnvoisMails, 30000);
  setInterval(traiterPostsReseaux, 30000);
  setInterval(traiterPublications, 45000);
  console.log(JETON_IG_ENV
    ? "Publication Instagram active (compte @domainedelacourdeslys)."
    : "Publication Instagram en veille (INSTAGRAM_TOKEN absent).");
})();
