: ${connu.statut || "?"}
- Projet : ${connu.titre_projet || "?"}
-   const corps = (mail.corps || mail.extrait || "").toLowerCase();
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
  const CODES = /code de verification|verification code|2fa|double authentification|reinitialisation|password reset|verify your device|connexion detectee|message vocal|appel manque|memory limit|deploy/;
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
  const DEMARCHAGE_TXT = /se desinscrire|desinscription|unsubscribe|votre visibilite|referencement|newsletter|webinar|nous serions ravis de|offre speciale|decouvrez notre|augmentez vos reservations|mettre en images vos/;
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
    if (/votre evenement|votre événement|votre mariage|votre seminaire|votre séminaire|devis pour votre|au domaine de la cour des lys/.test(tout)) {
      return { categorie: "prospect", dossier: "A rattacher",
        analyse: "Expediteur type banque mais le mail parle d'un evenement chez nous — a rattacher" };
    }
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable (banque, tresor public ou fournisseur)" };
  }

  /* 6. COMPTA par contenu — sans le mot "avoir" */
  if (/factur|releve bancaire|virement|prelevement|echeance de paiement|taxe de sejour|urssaf|impot|tva|comptabilit|declaration fiscale|ticket de paiement|note de frais|devis n°|avis de paiement/.test(tout)) {
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable ou taxe — a rapprocher de l'exercice" };
  }

  /* 7. Document d'organisation */
  if (/rooming|plan de table|deroul[ée]|liste des invit|etat des lieux|caution|attestation d'assurance/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Document d'organisation — expediteur inconnu, dossier a rattacher" };
  }

  /* 8. Demande entrante */
  if (/demande d'information|demande d'info|demande de renseignement|disponibilit|votre tarif|vos tarifs|visite|brochure|formulaire de demande|nouvelle demande/.test(tout)) {
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
let demandesEnCours = false;
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
${ev ? JSON.stringify({ client: ev.client, categorie: ev.categorie, type: ev.type, dateDebut: ev.dateDebut, dateFin: ev.dateFin, heureDebut: ev.heureDebut, heureFin: ev.heureFin, nbInvites: ev.nbInvites, nbRepas: ev.nbRepas, nbVinHonneur: ev.nbVinHonneur, ceremonie: ev.ceremonie }) : "(aucun)"}

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
  if (!tableDemandesOK || demandesEnCours || !CLE_IA) return;
  demandesEnCours = true;
  try {
    const { data } = await supabase.from("demandes_devis").select("*").limit(20);
    const attente = (data || []).filter((x) => (x.donnees || {}).statut === "en_attente");
    for (const dem of attente) await fabriquerDevis(dem);
  } catch (e) {
    console.log("  ! Demandes de devis :", e.message);
  } finally {
    demandesEnCours = false;
  }
}

/* ---------- Envoi des devis par mail (file envois_mails, deposee par l'equipe) ---------- */
let envoisDevisEnCours = false;

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
  if (!tableEnvoisOK || envoisDevisEnCours) return;
  envoisDevisEnCours = true;
  try {
    const { data } = await supabase.from("envois_mails").select("*").limit(20);
    const attente = (data || []).filter((x) => (x.donnees || {}).statut === "en_attente");
    for (const env of attente) await envoyerDevisParMail(env);
  } catch (e) {
    console.log("  ! Envois de devis :", e.message);
  } finally {
    envoisDevisEnCours = false;
  }
}

/* ---------- Redaction des posts reseaux (onglet Reseaux de CDL) ---------- */
let postsEnCours = false;

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

async function redigerPost(row) {
  const don = row.donnees || {};
  try {
    const message = `Reseau : ${don.reseau || "instagram"}
Date de publication prevue : ${don.date || "(libre)"}
Consigne de l'equipe : ${don.consigne || "(aucune — texte au gout de la maison)"}
${don.texte ? `Texte actuel a retravailler :\n${don.texte}` : "(pas encore de texte : redige-le)"}
La photo jointe est decrite par son nom de fichier : ${don.chemin || "?"}`;
    const texte = await appelerClaude(MODELE_REDACTION, LIGNE_EDITORIALE, message, 800);
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
  if (!tablePostsOK || postsEnCours || !CLE_IA) return;
  postsEnCours = true;
  try {
    const { data } = await supabase.from("posts_reseaux").select("*").limit(50);
    const attente = (data || []).filter((x) => (x.donnees || {}).statut === "a_rediger");
    for (const row of attente) await redigerPost(row);
  } catch (e) {
    console.log("  ! Posts reseaux :", e.message);
  } finally {
    postsEnCours = false;
  }
}

/* ---------- Un cycle de lecture ---------- */
async function cycle() {
  await verifierExtensionsV5();
  await chargerAnnuaire();

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

      const corps = (parsed.text || "").trim();
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
  console.log("CDL — Lecteur de boite mail v8.4 (LECTURE SEULE cote IMAP) demarre.");
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
})();
