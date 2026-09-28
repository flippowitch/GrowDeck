// Growplan 2.1 data: climate targets per phase, feeding schedules, tips and the
// safety checklist, taken over unchanged from the Growplan app (assets/index.html).
// Product names belong to their manufacturers; values are guide values from their charts.
// Texts that get stored (stage names, checklist items, tags, additives, schedules, tips) stay
// German here; they are translated where they are shown. Pure display labels use t() directly.
import { t } from '../i18n.js'

export const LAMP_DEFAULT = {name:"Spider Farmer G3000", ppf:852, watt:300, util:85, luxF:65, price:0.30};

export const ENV = {
  seed :{n:"Sämling / Steckling", ppfd:[150,300], h:18, tag:[22,26], nacht:[20,24], rh:[65,75], vpd:[0.4,0.8], hoehe:[55,70]},
  veg1 :{n:"Wachstum, frühe Wochen", ppfd:[300,500], h:18, tag:[22,27], nacht:[20,24], rh:[60,70], vpd:[0.8,1.0], hoehe:[50,60]},
  veg2 :{n:"Wachstum, späte Wochen", ppfd:[450,650], h:18, tag:[22,27], nacht:[20,24], rh:[55,65], vpd:[0.9,1.2], hoehe:[45,55]},
  flo1 :{n:"Blüte, Streckung", ppfd:[600,800], h:12, tag:[22,26], nacht:[19,22], rh:[50,60], vpd:[1.0,1.2], hoehe:[40,50]},
  flo2 :{n:"Blüte, Knospenaufbau", ppfd:[700,900], h:12, tag:[22,26], nacht:[18,21], rh:[45,55], vpd:[1.2,1.4], hoehe:[35,45]},
  flo3 :{n:"Blüte, Reife", ppfd:[700,900], h:12, tag:[20,25], nacht:[17,20], rh:[40,45], vpd:[1.3,1.6], hoehe:[35,45]},
  flush:{n:"Spülwoche", ppfd:[600,800], h:12, tag:[19,24], nacht:[16,19], rh:[35,45], vpd:[1.4,1.6], hoehe:[40,50]}
};
export const ENV_KEYS = ["seed","veg1","veg2","flo1","flo2","flo3","flush"];
export const ENV_FIELDS = [
  {k:"tag",   l:t("Temperatur Tag"),   u:"°C",       lo:5,   hi:40,   dec:1},
  {k:"nacht", l:t("Temperatur Nacht"), u:"°C",       lo:5,   hi:40,   dec:1},
  {k:"rh",    l:t("Luftfeuchte"),      u:"%",        lo:10,  hi:95,   dec:0},
  {k:"vpd",   l:"VPD",              u:"kPa",      lo:0.1, hi:3,    dec:2},
  {k:"ppfd",  l:"PPFD",             u:"µmol/m²s", lo:0,   hi:2500, dec:0},
  {k:"h",     l:t("Licht pro Tag"),    u:t("Stunden"),  lo:0,   hi:24,   dec:0, single:true},
  {k:"hoehe", l:t("Lampenabstand"),    u:"cm",       lo:5,   hi:200,  dec:0}
];
export const PH_MEDIUM = {erde:[6.0,6.8], kokos:[5.8,6.2], hydro:[5.5,6.2]};
export const MEDIUM_LBL = {erde:t("Erde"), kokos:t("Kokos"), hydro:t("Hydro")};
export const TYPE_LBL = {feed:t("Dünger"), water:t("Nur Wasser"), flush:t("Spülen"), note:t("Notiz")};
export const TYPE_SHORT = {feed:t("Dünger"), water:t("Wasser"), flush:t("Spülen"), note:t("Notiz")};
export const PHASE_LBL = {seed:t("Anzucht"), veg:t("Wachstum"), flower:t("Blüte")};
export const TAGS = ["Getoppt","LST / Training","Entlaubt","Umgetopft","Schädlinge behandelt","Blattspray","Geerntet"];
export const ADDITIVES = ["CalMag","PK 13/14","Silizium","Enzyme","Wurzelstimulator"];
export const COLORS = ["#2E7D32","#7CB342","#C62828","#D81B60","#EF6C00","#F9A825","#1565C0","#29B6F6","#6A1B9A","#6D4C41","#546E7A","#212121"];
export const PLANT_TYPES = {photo:t("Photoperiodisch"), auto:"Autoflower"};
export const CHECK_GROUPS = [["vor",t("Vor dem Mischen")],["beim",t("Beim Mischen")],["nach",t("Zum Schluss")]];
export const CHECK_DEFAULT = [
  {id:"d1",  g:"vor",  t:"Handschuhe anziehen (z. B. Nitril)"},
  {id:"d2",  g:"vor",  t:"Schutzbrille bei Konzentraten und pH-Minus/-Plus"},
  {id:"d3",  g:"vor",  t:"Gut lüften – dabei nicht essen, trinken oder rauchen"},
  {id:"d4",  g:"vor",  t:"Kinder und Haustiere fernhalten"},
  {id:"d5",  g:"vor",  t:"Etiketten und Sicherheitshinweise der Flaschen beachten"},
  {id:"d6",  g:"beim", t:"Eigene Messbecher und Spritzen verwenden, keine Küchenutensilien"},
  {id:"d7",  g:"beim", t:"Konzentrate nie direkt zusammenschütten – einzeln ins Wasser geben"},
  {id:"d8",  g:"beim", t:"pH-Minus/-Plus tropfenweise ins Gießwasser, nie Wasser in die Flasche"},
  {id:"d9",  g:"beim", t:"Verschüttetes sofort aufwischen"},
  {id:"d10", g:"nach", t:"Flaschen fest verschließen und außen abwischen"},
  {id:"d11", g:"nach", t:"Messbecher, Spritzen und Kanne ausspülen"},
  {id:"d12", g:"nach", t:"Alles sicher verstauen: in Originalflaschen, kühl, dunkel, frostfrei und für Kinder unerreichbar"},
  {id:"d13", g:"nach", t:"Handschuhe ausziehen und Hände gründlich waschen"}
];

/* =================== Düngeschemata =================== */
export function Z(n){ var a=[]; for(var i=0;i<n;i++) a.push(0); return a; }
export function F(n,val,from,to){ var a=Z(n); for(var i=from;i<=to;i++) a[i-1]=val; return a; }
export function P(n,k,v,b,t,u){ return {n:n,k:k,v:v,b:b,t:t||"",u:u||"ml"}; }

export function anSched(line, master){
  var L = {
    sensi:["Sensi Grow A","Sensi Grow B","Sensi Bloom A","Sensi Bloom B","Big Bud","pH Perfect Sensi","Erde / Hydro"],
    coco :["Sensi Coco Grow A","Sensi Coco Grow B","Sensi Coco Bloom A","Sensi Coco Bloom B","Big Bud Coco","pH Perfect Sensi Coco","Kokos"],
    conn :["Connoisseur Grow A","Connoisseur Grow B","Connoisseur Bloom A","Connoisseur Bloom B","Big Bud","pH Perfect Connoisseur","Erde / Hydro"]
  }[line];
  var p = [
    P(L[0],"base",[1,2,3,4],Z(8),"Basis A"),
    P(L[1],"base",[1,2,3,4],Z(8),"Basis B"),
    P(L[2],"base",Z(4),F(8,4,1,7),"Basis A"),
    P(L[3],"base",Z(4),F(8,4,1,7),"Basis B"),
    P("Voodoo Juice","add",F(4,2,1,2),F(8,2,1,2),"Wurzelbakterien")
  ];
  if(master){
    p.push(P("Piranha","add",F(4,2,1,2),F(8,2,1,2),"Mykorrhiza"));
    p.push(P("Tarantula","add",F(4,2,1,2),F(8,2,1,2),"Bodenbakterien"));
  }
  p.push(P("B-52","add",F(4,2,1,4),F(8,2,3,7),"Vitamine, Stressschutz"));
  p.push(P("Bud Ignitor","add",Z(4),F(8,2,1,2),"Blütenstart"));
  p.push(P(L[4],"add",Z(4),F(8,2,2,5),"Knospenmasse"));
  p.push(P("Bud Candy","add",master?F(4,2,1,4):Z(4),F(8,2,1,7),"Kohlenhydrate, Aroma"));
  if(master){
    p.push(P("Rhino Skin","add",F(4,2,1,4),F(8,2,1,7),"Silizium, feste Stängel"));
    p.push(P("Sensizym","add",F(4,2,1,4),F(8,2,1,7),"Enzyme, saubere Wurzelzone"));
    p.push(P("Bud Factor X","add",Z(4),F(8,2,1,7),"Harz und Terpene"));
    p.push(P("Nirvana","add",Z(4),F(8,2,3,7),"Reife, Aroma"));
  }
  p.push(P("Overdrive","add",Z(4),F(8,2,6,7),"Endspurt"));
  p.push(P("Flawless Finish","flush",Z(4),F(8,2,8,8),"Spülen, kein Basisdünger"));
  return {id:"an-"+line+"-"+(master?"master":"top"), brand:"Advanced Nutrients", name:L[5]+" · "+(master?"Master":"Top-Shelf"),
    medium:L[6], vegN:4, bloomN:8, flushN:1, hold:4, seed:"veg1", tips:"an", products:p,
    src:"Offizielle Advanced-Nutrients-Feedcharts (global, ml/L), "+(master?"Master":"Top-Shelf")+"-Rezept."};
}

export function bbSched(light){
  var p = [
    P("Root-Juice","add",[4,0],Z(9),"Wurzelstart"),
    P("Bio-Grow (oder Fish-Mix)","base",[0,light?2:1],light?[2,2,3,3,4,4,4,4,0]:[1,1,1,1,1,1,1,1,0],"Wachstum, auch in der Blüte"),
    P("Bio-Bloom","base",[0,0],[1,2,2,3,3,4,4,4,0],"Blüte"),
    P("Top-Max","add",[0,0],[1,1,1,1,1,4,4,4,0],"Blütestimulator"),
    P("Bio-Heaven","add",[2,2],[2,2,3,4,4,5,5,5,0],"Energie, Nährstoffaufnahme")
  ];
  if(light) p.push(P("Alg-A-Mic","add",[0,0],[1,2,2,3,3,4,4,4,0],"Vitalität"));
  p.push(P("Acti-Vera","add",[2,2],[2,2,3,4,4,5,5,5,0],"Abwehr, Bodenleben"));
  p.push(P("Microbes","add",[0.4,0.4],[0.2,0.2,0.4,0.4,0.4,0.2,0.2,0.2,0],"Pulver, nur 1× pro Woche","g"));
  return {id:"bb-"+(light?"light":"all"), brand:"BioBizz", name:light?"Light-Mix / Coco-Mix":"All-Mix",
    medium:light?"Light-Mix, Coco-Mix, leicht vorgedüngte Erde":"All-Mix, stark vorgedüngte Erde",
    vegN:2, bloomN:9, flushN:1, hold:8, seed:"water", organic:true, tips:"bb", products:p,
    src:"Offizielles BioBizz-Düngeschema (deutsche Fassung 2025). Spalten WK1–WK2 = Wachstum, WK3–WK10 = Blüte, WK11 = nur Wasser."};
}

export const AHH = {id:"ahh-df", brand:"Advanced Hydroponics", name:"Dutch Formula + Natural Power (Vorlage)",
  medium:"alle Substrate", vegN:3, bloomN:8, flushN:1, hold:4, seed:"veg1", phRange:[5.8,6.2], tips:"ahh",
  products:[
    P("Grow 1","base",[1,2,2],[1,1,1,0,0,0,0,0],"bis ca. 3 Wochen nach 12/12"),
    P("Micro 3","base",[-1,-1,-1],[-1,-1,-1,-1,-1,-1,-1,0],"ganzer Zyklus – Wert eintragen"),
    P("Bloom 2","base",[0.75,0.75,0.75],[1.5,1.5,1.5,1.5,3,3,3,0],"0,75 → 1,5 → 3 ml/L in der Endblüte"),
    P("Root Stimulator","add",[-1,-1,0],Z(8),"Wurzelstart – Wert eintragen"),
    P("Enzymes+","add",[1,1,1],[1,1,1,1,1,1,0,0],"bis 10–14 Tage vor der Ernte"),
    P("Growth/Bloom Excellarator","add",[-1,-1,-1],[-1,-1,-1,-1,-1,-1,0,0],"außer letzte 2 Wochen – Wert eintragen"),
    P("Final Solution","flush",Z(3),[0,0,0,0,0,0,0,1],"letzte Woche, nie mit Enzymes+")
  ],
  src:"Teilwerte aus Herstellerangaben: Grow 1 (1 / 2 / 2 ml/L Wachstum, 1 ml/L in Blütewoche 1–3), Bloom 2 (0,75 / 1,5 / 3 ml/L), Enzymes+ und Final Solution je 1 ml/L. Micro 3, Root Stimulator und Excellarator bitte aus dem Schema deiner Packung eintragen."};

export const BUILTIN = [anSched("sensi",false), anSched("sensi",true), anSched("coco",false), anSched("coco",true),
  anSched("conn",false), anSched("conn",true), bbSched(true), bbSched(false), AHH];

export const TIPS = {
  an:[
    "<b>Setzlinge und Stecklinge:</b> mit der Dosis aus Wachstumswoche 1 fahren.",
    "<b>Längere Wachstumsphase:</b> die letzte Wachstumswoche einfach wiederholen – die App macht das automatisch.",
    "<b>Blattspitzen verbrannt?</b> Basisdünger um 25 % reduzieren.",
    "<b>Autoflower und empfindliche Sorten:</b> mit 50–75 % Dosierstärke starten.",
    "<b>pH Perfect</b> puffert die Lösung selbst in den Bereich um 5,5–6,3. Bei hartem Leitungswasser trotzdem nachmessen.",
    "<b>Spülwoche:</b> letzte Woche ohne Basisdünger, nur Flawless Finish."
  ],
  bb:[
    "<b>WK1–WK2</b> sind Wachstum, mit der Umstellung auf 12/12 beginnt <b>WK3</b> – die App ordnet das automatisch deinen Wochen zu.",
    "<b>Erst düngen, wenn die Pflanze 10–15 cm hoch ist</b> oder 2–4 Blattpaare hat, vorher nur Wasser.",
    "<b>Bio-Grow oder Fish-Mix</b> – eines von beiden, nie zusammen.",
    "<b>Microbes</b> nur einmal pro Woche ins Gießwasser geben.",
    "<b>Flaschen schütteln</b> und die Lösung nicht auf Vorrat ansetzen – organischer Dünger kippt nach etwa einem Tag.",
    "<b>Osmose- oder sehr weiches Wasser:</b> CalMag ergänzen. EC-Werte sind bei organischem Dünger nur begrenzt aussagekräftig.",
    "<b>Ziel-pH</b> auf Erde 6,2–6,5, auf Kokos niedriger."
  ],
  ahh:[
    "<b>Grow 1</b> etwa 3–4 Wochen nach der Umstellung auf 12/12 absetzen.",
    "<b>Die Mengen gelten für Kokos, Steinwolle und Hydro</b> mit Ausgangswasser um EC 0,5. In Erde empfiehlt der Hersteller die halbe Dosis – Stärke-Regler auf 50 %.",
    "<b>pH</b> nach dem Mischen auf 5,8–6,2 einstellen.",
    "<b>Enzymes+ und Final Solution</b> nicht gleichzeitig verwenden.",
    "<b>Fehlende Werte:</b> Tippe oben auf „Schema anpassen“ und trag Micro 3, Root Stimulator und Excellarator aus deinem Schema ein."
  ],
  custom:[
    "<b>Eigenes Schema:</b> Die Werte werden aus deiner Tabelle übernommen und auf deine Wochenzahl verteilt.",
    "Leeres Feld = Produkt in dieser Woche nicht verwenden, „?“ = Wert noch unbekannt."
  ]
};
export const MIX_ORDER = {
  an:"<b>Mischreihenfolge:</b> Wasser → Teil A einrühren → Teil B einrühren → Zusätze einzeln, jeweils gut umrühren. A und B nie unverdünnt zusammenschütten.",
  bb:"<b>Mischen:</b> Alle Produkte dürfen ins selbe Gießwasser – Flaschen schütteln, einzeln einrühren.",
  ahh:"<b>Mischen:</b> Komponenten einzeln einrühren, nach jeder gut umrühren und zum Schluss den pH-Wert einstellen.",
  custom:"<b>Mischen:</b> Komponenten einzeln einrühren und nach jeder gut umrühren."
};
