// Versione diretta: apre il pannello “Scrivi una recensione” quando Google lo consente.
// Questo URL usa il riferimento luogo estratto dal link Google Maps fornito.
// Fallback: se Google cambia comportamento, aprirà comunque la scheda dello studio.
const GOOGLE_REVIEW_URL = "https://search.google.com/local/writereview?placeid=ChIJt7LImAxRgUcRalePKYS3Ia0&hl=it";

const questions = [
  { id: "welcome", label: "Come valuti accoglienza e cortesia dello studio?" },
  { id: "clarity", label: "Quanto sono state chiare le spiegazioni ricevute?" },
  { id: "professionalism", label: "Come valuti professionalità e attenzione?" },
  { id: "recommend", label: "Quanto consiglieresti questo studio?" }
];

const answers = Object.fromEntries(questions.map(q => [q.id, 0]));

const stepIntro = document.getElementById("stepIntro");
const reviewForm = document.getElementById("reviewForm");
const stepSplash = document.getElementById("stepSplash");
const questionsEl = document.getElementById("questions");
const progressBar = document.getElementById("progressBar");
let generatedReviewText = "";
const copyStatus = document.getElementById("copyStatus");
const reviewPreviewBox = document.getElementById("reviewPreviewBox");
const reviewTextPreview = document.getElementById("reviewTextPreview");

function renderQuestions() {
  questionsEl.innerHTML = questions.map(q => `
    <div class="question" data-question="${q.id}">
      <h3>${q.label}</h3>
      <div class="stars" role="radiogroup" aria-label="${q.label}">
        ${[1,2,3,4,5].map(value => `
          <button class="star" type="button" data-value="${value}" aria-label="${value} stelle">★</button>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function updateStars(questionId) {
  const questionEl = document.querySelector(`[data-question="${questionId}"]`);
  questionEl.querySelectorAll(".star").forEach(star => {
    star.classList.toggle("active", Number(star.dataset.value) <= answers[questionId]);
  });
  const completed = Object.values(answers).filter(Boolean).length;
  progressBar.style.width = `${(completed / questions.length) * 100}%`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(list) {
  return [...list].sort(() => Math.random() - 0.5);
}

function band(value) {
  if (value >= 5) return "top";
  if (value === 4) return "good";
  if (value === 3) return "ok";
  return "low";
}

function polishComment(comment) {
  if (!comment) return "";
  let cleaned = comment.trim().replace(/\s+/g, " ");
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (!/[.!?]$/.test(cleaned)) cleaned += ".";
  return cleaned;
}

const openings = {
  top: [
    "Esperienza davvero eccellente: fin dal primo momento ho percepito uno studio curato, organizzato e orientato al benessere del paziente.",
    "Ho avuto un'impressione estremamente positiva dello studio, sia per l'accoglienza sia per la qualità complessiva dell'esperienza.",
    "Uno studio che trasmette professionalità, ordine e attenzione ai dettagli già dall'arrivo.",
    "La mia esperienza è stata ottima sotto ogni punto di vista: ambiente accogliente, personale cortese e grande cura nel rapporto con il paziente."
  ],
  good: [
    "Esperienza molto positiva in uno studio accogliente, ben organizzato e professionale.",
    "Ho apprezzato la cura con cui sono stato seguito e la sensazione generale di serietà e attenzione.",
    "La mia impressione è stata molto buona: ambiente piacevole, personale disponibile e approccio professionale.",
    "Nel complesso ho trovato uno studio attento, ordinato e capace di mettere il paziente a proprio agio."
  ],
  ok: [
    "Esperienza complessivamente positiva, con diversi aspetti apprezzabili nella gestione del paziente.",
    "Nel complesso ho avuto una buona impressione dello studio, soprattutto per la disponibilità e l'organizzazione.",
    "La mia esperienza è stata positiva, con un servizio generalmente attento e professionale.",
    "Ho trovato uno studio valido, con un approccio serio e un'accoglienza complessivamente buona."
  ],
  low: [
    "La mia esperienza ha avuto alcuni elementi positivi, anche se ci sono aspetti che potrebbero essere ulteriormente migliorati.",
    "Ho riscontrato disponibilità e professionalità, ma ritengo che alcuni dettagli possano essere perfezionati.",
    "Nel complesso lo studio mostra attenzione al paziente, pur con margini di miglioramento nell'esperienza complessiva.",
    "Il servizio ha alcune qualità apprezzabili, ma secondo me ci sono punti su cui si potrebbe lavorare per rendere l'esperienza più fluida."
  ]
};

const themes = {
  welcome: {
    top: [
      "L'accoglienza è stata impeccabile, cortese e discreta, con un'atmosfera rassicurante.",
      "Il personale mi ha accolto con grande gentilezza, creando subito un clima sereno e professionale.",
      "Ho apprezzato molto la cortesia alla reception e la cura nel far sentire il paziente seguito."
    ],
    good: [
      "L'accoglienza è stata molto cortese e l'ambiente trasmette ordine e tranquillità.",
      "Il personale si è dimostrato disponibile e attento, con modi gentili e professionali.",
      "Ho trovato un ambiente piacevole e un'accoglienza decisamente positiva."
    ],
    ok: [
      "L'accoglienza è stata corretta e l'ambiente complessivamente gradevole.",
      "Il primo impatto con lo studio è stato positivo, con personale disponibile.",
      "Ho trovato cortesia e disponibilità, anche se qualche dettaglio potrebbe essere reso ancora più fluido."
    ],
    low: [
      "L'accoglienza è stata adeguata, ma potrebbe risultare ancora più calda e personalizzata.",
      "Il personale è stato disponibile, anche se l'esperienza iniziale potrebbe essere migliorata.",
      "L'ambiente è ordinato, ma l'accoglienza potrebbe essere resa più rassicurante."
    ]
  },
  clarity: {
    top: [
      "Le spiegazioni sono state chiare, precise e formulate con un linguaggio comprensibile.",
      "Ho ricevuto informazioni complete e ben spiegate, senza fretta e con grande chiarezza.",
      "La comunicazione è stata uno degli aspetti migliori: chiara, pacata e molto rassicurante."
    ],
    good: [
      "Le spiegazioni sono state chiare e mi hanno aiutato a comprendere bene i passaggi principali.",
      "Ho apprezzato la disponibilità nel chiarire dubbi e nel comunicare in modo semplice.",
      "La comunicazione è stata efficace, con spiegazioni comprensibili e ben strutturate."
    ],
    ok: [
      "Le spiegazioni sono state nel complesso comprensibili.",
      "La comunicazione è stata positiva, anche se qualche dettaglio avrebbe potuto essere approfondito meglio.",
      "Ho ricevuto le informazioni essenziali in modo sufficientemente chiaro."
    ],
    low: [
      "Avrei gradito qualche spiegazione in più, soprattutto per sentirmi pienamente orientato.",
      "La comunicazione è stata corretta, ma potrebbe essere resa ancora più chiara e completa.",
      "Sarebbe utile dedicare più spazio al chiarimento dei passaggi e delle informazioni principali."
    ]
  },
  professionalism: {
    top: [
      "Ho percepito un livello molto alto di competenza, precisione e attenzione ai dettagli.",
      "La professionalità dello studio emerge nella cura dell'organizzazione e nel modo in cui il paziente viene seguito.",
      "Mi sono sentito seguito con attenzione, competenza e grande rispetto dei tempi e delle esigenze personali."
    ],
    good: [
      "La professionalità è evidente e l'attenzione al paziente è stata molto apprezzabile.",
      "Ho percepito serietà, competenza e una buona cura nella gestione complessiva.",
      "Lo studio trasmette affidabilità e attenzione, con un approccio professionale e ordinato."
    ],
    ok: [
      "La professionalità è stata buona e l'organizzazione complessivamente adeguata.",
      "Ho riscontrato un approccio serio e una discreta attenzione al paziente.",
      "L'esperienza è stata gestita in modo professionale, con alcuni aspetti ancora migliorabili."
    ],
    low: [
      "La professionalità è presente, ma alcuni aspetti dell'organizzazione potrebbero essere più curati.",
      "Ho percepito serietà, anche se l'attenzione ai dettagli potrebbe migliorare.",
      "L'approccio è professionale, ma l'esperienza potrebbe risultare più attenta e coordinata."
    ]
  },
  recommend: {
    top: [
      "Lo consiglierei senza esitazione a chi cerca uno studio dentistico serio, elegante e attento alla persona.",
      "È uno studio che consiglierei volentieri per la qualità dell'accoglienza e la sensazione di affidabilità che trasmette.",
      "Consiglio questo studio a chi desidera sentirsi seguito con cura, chiarezza e professionalità."
    ],
    good: [
      "Lo consiglierei a chi cerca uno studio professionale, cortese e ben organizzato.",
      "È una realtà che mi sento di consigliare per serietà, disponibilità e attenzione al paziente.",
      "Consiglio lo studio per l'ambiente curato e per l'approccio professionale."
    ],
    ok: [
      "Nel complesso lo considero uno studio valido.",
      "È uno studio che può rappresentare una buona scelta, soprattutto per chi cerca serietà e disponibilità.",
      "La mia valutazione complessiva è positiva."
    ],
    low: [
      "Mi auguro che questo feedback possa essere utile per migliorare ulteriormente l'esperienza dei pazienti.",
      "Con alcuni miglioramenti, l'esperienza potrebbe diventare decisamente più soddisfacente.",
      "Il potenziale c'è, ma alcuni aspetti potrebbero essere affinati."
    ]
  }
};

function generateReview() {
  const comment = polishComment(document.getElementById("freeComment").value);
  const avg = Object.values(answers).reduce((a, b) => a + b, 0) / questions.length;
  const overallBand = band(Math.round(avg));

  const selectedThemes = shuffle([
    pick(themes.welcome[band(answers.welcome)]),
    pick(themes.clarity[band(answers.clarity)]),
    pick(themes.professionalism[band(answers.professionalism)])
  ]);

  const paragraphs = [
    pick(openings[overallBand]),
    selectedThemes.slice(0, 2).join(" "),
    selectedThemes[2],
    pick(themes.recommend[band(answers.recommend)])
  ];

  if (comment) {
    paragraphs.splice(3, 0, comment);
  }

  return paragraphs.join("\n\n");
}

function showManualCopyFallback(text) {
  reviewTextPreview.value = text;
  reviewPreviewBox.classList.add("hidden");
  copyStatus.textContent = "Se il testo non è già negli appunti, premi “Copia di nuovo il testo”.";
  copyStatus.classList.add("error");
}

function copyWithHiddenTextarea(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, 99999);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

async function copyText(text) {
  reviewTextPreview.value = text;
  reviewPreviewBox.classList.add("hidden");

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      copyStatus.textContent = "La recensione è copiata. Su Google tocca il riquadro, tieni premuto e scegli “Incolla”.";
      copyStatus.classList.remove("error");
      return true;
    }
  } catch (error) {
    // Se la Clipboard API fallisce, proviamo il fallback classico sotto.
  }

  if (copyWithHiddenTextarea(text)) {
    copyStatus.textContent = "La recensione è copiata. Su Google tocca il riquadro, tieni premuto e scegli “Incolla”.";
    copyStatus.classList.remove("error");
    return true;
  }

  showManualCopyFallback(text);
  return false;
}

document.getElementById("startBtn").addEventListener("click", () => {
  stepIntro.classList.add("hidden");
  reviewForm.classList.remove("hidden");
});

questionsEl.addEventListener("click", event => {
  const star = event.target.closest(".star");
  if (!star) return;
  const questionId = star.closest(".question").dataset.question;
  answers[questionId] = Number(star.dataset.value);
  updateStars(questionId);
});

reviewForm.addEventListener("submit", async event => {
  event.preventDefault();
  const missing = questions.find(q => !answers[q.id]);
  if (missing) {
    alert("Rispondi a tutte le domande prima di aprire Google.");
    return;
  }

  generatedReviewText = generateReview();
  reviewForm.classList.add("hidden");
  stepSplash.classList.remove("hidden");

  const copied = await copyText(generatedReviewText);

  // Se la copia è riuscita, apriamo Google. Se non è riuscita, restiamo qui
  // così il paziente può copiare manualmente il testo prima di uscire dalla pagina.
  if (copied) {
    setTimeout(() => {
      window.location.href = GOOGLE_REVIEW_URL;
    }, 650);
  }
});

document.getElementById("manualCopyBtn").addEventListener("click", () => copyText(generatedReviewText));

document.getElementById("toggleTextBtn").addEventListener("click", () => {
  const isHidden = reviewPreviewBox.classList.toggle("hidden");
  document.getElementById("toggleTextBtn").textContent = isHidden ? "Mostra il testo preparato" : "Nascondi il testo preparato";
});

document.getElementById("openAgainBtn").addEventListener("click", () => {
  window.location.href = GOOGLE_REVIEW_URL;
});

renderQuestions();
