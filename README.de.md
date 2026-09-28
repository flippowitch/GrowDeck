# GrowDeck

GrowDeck ist eine selbst gehostete Steuerzentrale für Growzelte. Sie bringt die
Geräte von **Spider Farmer (GGS)**, **Vivosun (GrowHub)** und **AC Infinity (UIS)** in
einer Weboberfläche zusammen: Klima pro Zelt mit VPD-Diagramm, alle Ausgänge schalten
und dimmen, Zeitpläne und Modi direkt auf den Geräten einstellen, Verlauf,
herstellerübergreifende Regeln, Alarme und Benachrichtigungen. Dazu kommt der
**Growplan**: Düngeschema, Klima- und Lichtziele pro Woche, Sicherheits-Checkliste und
Gießprotokoll – die Funktionen der Growplan-App, verbunden mit den Geräten im Zelt –,
Alarme, die den Zielen des Plans folgen, Gieß-Erinnerungen, tägliche Fotos mit
Zeitraffer, ein Archiv abgeschlossener Grows und eine nächtliche Datensicherung.

GrowDeck läuft als Docker-Projekt, zum Beispiel auf einer UGREEN-NAS mit UGOS Pro. Die
Oberfläche gibt es auf Deutsch und Englisch.

> 🇬🇧 English: [README.md](README.md) · **[▶ Live-Demo](https://YOUR-GITHUB-USER.github.io/growdeck/)**
> (läuft komplett im Browser mit simulierten Geräten)

## Was unterstützt wird

| Hersteller | Gerät | In GrowDeck |
|---|---|---|
| Spider Farmer | GGS Controller | Klima (Temperatur, Feuchte, VPD, CO₂, PPFD), Bodensonden, Licht dimmen, Abluft, Umluft inkl. natürlichem Wind, Heizung, Befeuchter und Entfeuchter (Ein/Aus, Modus); Zeitpläne, Zyklen, Klimamodi, Klimaziele |
| Spider Farmer | GGS Power Strip AC5 / AC10 | Alle Steckdosen mit allen Modi (Manuell, Zeitplan, Zyklus, Temperatur, Luftfeuchte, CO₂, Tropfbewässerung mit Bodensonde), Licht-Kanäle, eigene Sensoren |
| Spider Farmer | GGS Light Controller | Licht 1 und 2: Dimmen, Zeitplan mit Helligkeit, Zyklus, PPFD-Automatik, Hitzeschutz |
| Spider Farmer | Sensoren (Temperatur/Feuchte, SensorPro PPFD, CO₂, 3-in-1-Bodensonde) | Als Messwerte des jeweiligen Controllers |
| Spider Farmer | Unbekannte oder neue GGS-Module (z. B. S Station) | Werden generisch erkannt: Messwerte und schaltbare Ausgänge, sofern sie dem GGS-Schema folgen |
| Vivosun | GrowHub-Controller (z. B. E42A) | Klima innen und außen, VPD, Licht (Stufe, Spektrum), Abluft inkl. Automatik-Grenzen, Umluft (Stufe, Schwenken, natürlicher Wind, Nachtmodus) |
| Vivosun | AeroStream-Befeuchter, AeroFlux-Heizung, Entfeuchter, AeroLush-Klimagerät | Ein/Aus, Stufe und Modus (sofern vorhanden), Zielwerte, Betriebsart und Lüfterstufe beim Klimagerät, Wasserstand |
| Vivosun | VCure (Trocknen/Curing) | Klima in der Box, Programme (Schnell, Veredeln, Curing, Kalt, Extrakt), Licht, Scheibe, Sperre |
| Vivosun | GrowHub A10 / A22 (WLAN-Steckdosen) | Ein/Aus je Steckdose (A22: zwei Steckdosen und USB), Sonde des A22; Modus und Programme bleiben der Vivosun-App vorbehalten (siehe „Aktueller Stand“) |
| Vivosun | GrowCam | Fotos zu festen Zeiten über RTSP im Heimnetz, Galerie, Zeitraffer, Fotos im Gießprotokoll |
| Andere Kameras | Alles mit RTSP-Stream oder Standbild-Adresse (http/https) | Wie GrowCam |
| AC Infinity | Controller 69 WiFi, 69 Pro, 69 Pro+ | Temperatur, Luftfeuchte, VPD; jeder UIS-Port mit Ein/Aus, Stufe 0–10 und allen Modi (Aus, An, Auto, Timer, Zyklus, Zeitplan, VPD) samt Grenzwerten, Zielwerten, Timern und Zeitplan |
| AC Infinity | Controller AI+ | Wie oben, dazu die steckbaren Sensoren (CO₂ und Licht, Bodenfeuchte, Wassermelder, pH, EC/TDS, Wassertemperatur) und die Sensor-Modi (CO₂, CO₂-Lüfter, Bodenfeuchte, Wassertemperatur, pH, EC/TDS, Wassermelder) |
| AC Infinity | UIS Outlet AI / AI+ | Jede Steckdose mit Ein/Aus und allen Modi |
| AC Infinity | Controller 67, Controller 69 ohne WLAN | Nicht möglich: Diese Controller senden nur per Bluetooth und nicht in die Cloud |

Regeln verbinden jeden Sensor mit jedem Ausgang, auch über die Hersteller
hinweg, zum Beispiel: Vivosun-Befeuchter an, wenn der Spider-Farmer-Sensor
unter 55 % misst.

## Installation auf einer UGREEN-NAS

Voraussetzungen: UGOS Pro mit der App **Docker**, Internetzugang beim ersten Start
(zum Bauen der Images).

1. Den Ordner `growdeck` auf die NAS kopieren, zum Beispiel nach
   `/volume1/docker/growdeck` (freigegebener Ordner „docker“).
2. Im Ordner die Datei `.env.example` kopieren und die Kopie `.env` nennen.
   Mindestens `APP_PASSWORD` ändern. Die Datei lässt sich mit dem Texteditor der
   UGOS-Dateiverwaltung bearbeiten.
3. In der Docker-App **Projekt → Erstellen** wählen, einen Namen vergeben
   (z. B. `growdeck`) und als Pfad den Ordner `growdeck` angeben. UGOS erkennt die
   `docker-compose.yml`. Mit **Bereitstellen** starten. Der erste Start dauert
   einige Minuten, weil die Images gebaut werden.
4. Im Browser `http://IP-DER-NAS:8080` öffnen und mit dem Passwort anmelden.

Alternativ per SSH im Ordner:

```sh
cp .env.example .env    # anschließend bearbeiten
sudo docker compose up -d --build
sudo docker compose logs -f growdeck
```

Ohne `APP_PASSWORD` erzeugt GrowDeck beim ersten Start ein Passwort. Es steht im
Protokoll des Containers `growdeck` und in `data/generated-password.txt`.

### Erst mal ausprobieren: Demo-Modus

Mit `DEMO_MODE=true` in der `.env` startet GrowDeck mit simulierten Geräten aller
drei Hersteller (GGS Controller, AC5, AC10, Light Controller, GrowHub, AeroStream,
AeroFlux, Entfeuchter, AeroLush, VCure, GrowCam, GrowHub A10 und A22, AC Infinity
Controller AI+, 69 Pro und Outlet AI+) samt Beispielräumen, Regel, Alarmen, einer
Demo-Kamera mit drei Wochen Fotos und einem archivierten Grow. Alles lässt sich bedienen, ohne echte Hardware. Zum Umstellen auf echte
Geräte `DEMO_MODE=false` setzen, den Ordner `data` löschen und das Projekt neu
starten.

## Spider Farmer verbinden

Die GGS-Module sprechen nur mit `sf.mqtt.spider-farmer.com` (Port 8883, TLS). Der
Container `growdeck-spiderproxy` nimmt diese Verbindung auf der NAS an, reicht die
Daten an GrowDeck weiter und hält gleichzeitig die Verbindung zur
Spider-Farmer-Cloud. Die Spider-Farmer-App funktioniert dadurch weiter.

Damit die Module die NAS statt der Cloud erreichen, muss der Name
`sf.mqtt.spider-farmer.com` in deinem Heimnetz auf die IP-Adresse der NAS zeigen.
Dafür gibt es drei Wege:

**A. Mitgelieferter DNS-Dienst (für Fritz!Box und ähnliche Router)**

1. In der `.env` die Zeile `COMPOSE_PROFILES=dns` aktivieren und `NAS_IP` auf die
   IP-Adresse der NAS setzen. Die NAS sollte im Router eine feste IP haben.
2. Projekt neu bereitstellen. Der Container `growdeck-dns` beantwortet nur diesen
   einen Namen selbst und leitet alle anderen Anfragen an 1.1.1.1 und 9.9.9.9 weiter.
3. Fritz!Box: *Heimnetz → Netzwerk → Netzwerkeinstellungen → IPv4-Einstellungen*,
   bei „Lokaler DNS-Server“ die IP der NAS eintragen. Die Fritz!Box verteilt die NAS
   dann per DHCP als DNS-Server.

Falls Port 53 auf der NAS schon belegt ist, startet der DNS-Dienst nicht. Dann Weg B
oder C nutzen.

**B. Vorhandener DNS-Filter (AdGuard Home, Pi-hole)**

Eine DNS-Umschreibung anlegen: `sf.mqtt.spider-farmer.com` → IP der NAS. Der
DNS-Dienst aus Weg A wird dann nicht gebraucht.

**C. Router mit NAT-Regeln (OpenWrt, OPNsense, pfSense, UniFi)**

Verbindungen der Spider-Farmer-Module zu Port 8883 auf die NAS (Port 8883)
umleiten (Destination-NAT). Die Fritz!Box kann das nicht.

Danach die Module kurz vom Strom trennen. Nach etwa einer Minute erscheinen sie
unter **Geräte**. Unter **Optionen → Verbindungen** zeigt GrowDeck, ob der Broker
verbunden ist und wie viele Nachrichten ankommen.

Zum Proxy: Der `spiderproxy` stammt aus dem Projekt
[Schedule 4 Real](https://github.com/EddiePiazza/schedule-4-real) und ist nicht
Teil von GrowDeck. Er ist nur als ausführbare Datei ohne Quelltext und ohne
Lizenzangabe veröffentlicht. Das Dockerfile lädt ihn beim Bauen von einem fest
eingestellten Stand des öffentlichen Repositorys. Entscheide selbst, ob du ihn
einsetzen möchtest. Wer keine Spider-Farmer-Geräte hat, kann den Dienst
`spiderproxy` aus der `docker-compose.yml` entfernen und
`SPIDERFARMER_ENABLED=false` setzen.

## Vivosun verbinden

Vivosun-Geräte lassen sich nur über die Vivosun-Cloud steuern. Unter
**Optionen → Verbindungen** E-Mail und Passwort des Vivosun-Kontos eintragen
(oder `VIVOSUN_EMAIL` und `VIVOSUN_PASSWORD` in der `.env`). GrowDeck liest die
Messwerte etwa jede Minute und schickt Befehle sofort über die Cloud. Ohne
Internetverbindung sind Vivosun-Geräte in GrowDeck nicht erreichbar; ihre eigenen
Einstellungen laufen auf den Geräten weiter.

Die Zugangsdaten liegen unverschlüsselt in der Datenbank im Datenordner.

## AC Infinity verbinden

AC Infinity bietet keine lokale Schnittstelle für die WLAN-Controller. Unter
**Optionen → Verbindungen** E-Mail und Passwort des AC-Infinity-Kontos eintragen
(oder `ACINFINITY_EMAIL` und `ACINFINITY_PASSWORD` in der `.env`). GrowDeck fragt
die Controller standardmäßig alle 10 Sekunden ab (einstellbar ab 5 Sekunden unter
**Optionen → Daten**) und schickt Befehle sofort.

Jeder Controller erscheint als Gerät, jeder Port als Ausgang. Den Namen des Ports
übernimmt GrowDeck aus der App, den Gerätetyp (Licht, Befeuchter, Lüfter …) aus der
Port-Einstellung „Device Type“. Der Regler zeigt die Stufe, mit der der Port im
Modus „An“ läuft; die Statuszeile zeigt, wie schnell er gerade wirklich läuft. Unter
**Geräte → Port einrichten** lassen sich Modus, Stufen, Auto- und VPD-Grenzen,
Zielwerte, Timer, Zyklus, Zeitplan und beim AI+ die Sensor-Modi einstellen. Der
Controller führt das selbst aus.

Nicht möglich sind Controller, die nur per Bluetooth arbeiten (Controller 67,
Controller 69 ohne WLAN oder im reinen Bluetooth-Modus): Sie senden keine Daten in
die Cloud. EC/TDS-Grenzen und die erweiterten Geräteeinstellungen (Kalibrierung,
dynamische Reaktion) bleiben der AC-Infinity-App vorbehalten.

## Mehrere Hersteller in einem Zelt: die Zeltsteuerung

Ein Raum (Zelt) kann Geräte aller Hersteller gleichzeitig enthalten, zum Beispiel
einen Spider-Farmer-Controller mit Licht, einen Vivosun-Befeuchter und eine
AC-Infinity-Abluft. Zugeordnet werden sie unter **Optionen → Räume** oder direkt in
der Zeltsteuerung.

Die **Zeltsteuerung** (in der Übersicht beim jeweiligen Zelt, „Zeltsteuerung
einrichten“) lässt diese Geräte zusammenarbeiten. GrowDeck übersetzt dabei zwischen
den Herstellern: Die Geräte selbst müssen nichts voneinander wissen.

- **Messwerte:** der Klimasensor des Raums oder der Mittelwert aller Sensoren im Zelt,
  herstellerübergreifend.
- **Tag und Nacht:** nach der Uhrzeit des Raums oder nach dem tatsächlichen Zustand
  eines Lichts. Schaltet das Spider-Farmer-Licht aus, gelten sofort die Nachtziele
  für alle anderen Geräte.
- **Ziele:** Temperatur für Tag und Nacht, Luftfeuchte oder VPD für Tag und Nacht,
  optional CO₂ am Tag, jeweils mit Toleranz.
- **Aufgaben:** Jeder Ausgang bekommt eine Aufgabe: Licht (wird nur gelesen), Abluft,
  Umluft, Befeuchter, Entfeuchter, Heizung, Kühlung, CO₂. „Vorschlag aus dem Raum“
  ordnet sie nach Gerätetyp zu.
- **Abstimmung:** Befeuchter und Entfeuchter laufen nie gleichzeitig. Die Abluft
  regelt stufenlos nach „zu warm oder zu feucht“ und wird gedrosselt, solange
  befeuchtet, geheizt oder CO₂ zugegeben wird (außer es ist zu heiß). Heizung und
  Kühlung arbeiten mit Hysterese, Schaltvorgänge sind auf höchstens einen pro Minute
  und Ausgang begrenzt.

Die Übersicht zeigt für jeden Ausgang, was er gerade tut und warum. Ausgänge der
Zeltsteuerung werden von Regeln nicht geschaltet, damit sich beide nicht abwechseln;
die Regel zeigt dann einen Hinweis.

**Kopplungen:** Für direkte Verbindungen zwischen Geräten gibt es in den Regeln die
Bedingung „Anderes Gerät“: Ein Ausgang reagiert darauf, ob ein anderer Ausgang an
oder aus ist, auch über Hersteller hinweg. Beispiel aus der Demo: Solange der
Vivosun-Entfeuchter läuft, schaltet eine Spider-Farmer-Steckdose einen Zusatzlüfter.

## Growplan: Wochenplan, Dünger und Gießprotokoll

Der Menüpunkt **Growplan** enthält alle Funktionen der Growplan-App (2.1) und
speichert sie in GrowDeck statt nur auf dem Handy. Jedes Zelt bekommt einen eigenen
Plan; ohne angelegten Raum gibt es einen Plan für alle Geräte, den du später einem
Zelt zuordnen kannst.

- **Heute:** Woche und Phase (automatisch aus „Start Wachstum“ und „Umstellung 12/12“,
  sonst per Pfeil), Sollwerte der Woche für PPFD, Dimmer, Temperatur, Luftfeuchte,
  VPD, pH, Lichtstunden und DLI – jeweils mit dem Messwert aus dem Zelt daneben
  (grün im Ziel, orange knapp daneben, rot deutlich daneben). „Kanne mischen“
  rechnet die Düngermengen für Wassermenge und Dosierstärke aus und trägt sie als
  Gießung ein. Dazu die Sicherheits-Checkliste (setzt sich täglich zurück, eigene
  Punkte möglich), bis zu 12 Pflanzen mit Sorte, Typ, Topf und Alter sowie das Setup.
- **Dünger:** alle Schemata der App (Advanced Nutrients Sensi, Coco und Connoisseur
  jeweils Top-Shelf und Master, BioBizz Light-Mix und All-Mix, Advanced Hydroponics)
  plus eigene Schemata. Werte, Produkte, Farben, Ziel-EC, Kommentare je Woche und
  zum Schema lassen sich anpassen; das Original bleibt wiederherstellbar. Weicht
  die Wochenzahl ab, verteilt GrowDeck das Schema wie die App auf deine Wochen.
- **Protokoll:** Gießungen, Spülen und Notizen mit EC/pH von Gießwasser und Drain,
  Zusätzen und Maßnahmen, Filter nach Pflanze, Statistik, EC- und pH-Verlauf mit
  pH-Zielband. Export als CSV oder Text. „Backup speichern“ und „Backup laden“
  nutzen das Format der Growplan-App: Backups der App lassen sich direkt einlesen
  (Einträge, eigene Schemata, Checkliste und – bei leerem Protokoll – die
  Einstellungen) und umgekehrt wieder in der App laden.
- **Klima:** VPD-Rechner (Blatt zu Luft) mit „Werte aus dem Zelt übernehmen“,
  Zielwerte je Phase (anpassbar) und die Verbindung zur Zeltsteuerung.
- **Licht:** Dimmer und Lampenabstand der Woche, Dimmer-Rechner mit PPFD, Lux, DLI,
  Verbrauch und Stromkosten, „Auf … % stellen“ für dimmbare Lichter im Zelt,
  Lux-Messung umrechnen, Tabelle je Phase, eigene Lampe und ein Abgleich der
  Lichtzeiten des Zelts mit dem Plan (12/12 oder 18/6).

In der **Übersicht** zeigt jedes Zelt mit Growplan Phase und Woche, die letzte
Gießung und das voraussichtliche Erntedatum, und die Messwerte werden mit den Zielen
der aktuellen Woche verglichen:

- unter Temperatur, Luftfeuchte, VPD und PPFD steht der Zielbereich für jetzt (Tag
  oder Nacht) mit „passt“, „zu warm“, „zu feucht“ usw.; die Zahl ist grün im Ziel,
  orange knapp daneben und rot deutlich daneben,
- die Verläufe zeigen die Zielbereiche für Tag und Nacht als Band, dazu den Anteil
  der Zeit im Ziel; Tooltip und Tabelle nennen Abweichungen in Worten,
- ein Hinweis erscheint, wenn die Lichtzeit des Zelts nicht zum Plan passt (etwa
  18/6 statt 12/12) oder die Zeltsteuerung mit eigenen Zielen außerhalb der
  Planbereiche regelt; „Growplan-Ziele übernehmen“ stellt sie direkt um.

Ohne Growplan vergleicht die Übersicht mit den Zielen der Zeltsteuerung, sonst mit dem
VPD-Richtwert der Phase des Raums. Die **Zeltsteuerung** kann ihre Ziele aus dem Plan übernehmen
(„Ziele aus dem Growplan übernehmen“): Temperatur und Luftfeuchte als Mitte der
Zielbereiche, Toleranz bis zum Rand, und sie wechselt die Ziele automatisch mit der
Woche. Growplans VPD-Ziele sind Blatt-VPD; die Geräte messen den VPD der Luft.
GrowDeck rechnet das Tagesziel deshalb mit dem Wert „Blatt kühler“ aus dem VPD-Rechner
um (Standard 2 K), nachts gilt Blatt gleich Luft.

## Alarme, die dem Growplan folgen

Unter **Alarme → Growplan-Alarm** (oder im Growplan unter **Klima**) überwacht ein
Alarm das Klima eines Zelts gegen die Zielbereiche der aktuellen Woche: Temperatur,
Luftfeuchte und VPD, getrennt für Tag und Nacht. Die Grenzen wandern mit dem Plan,
es muss nichts nachgestellt werden. Einstellbar sind die Werte, die Verzögerung
(Standard 30 Minuten außerhalb) und ob mit Spielraum (1 °C, 5 %, 0,15 kPa über den
Rand hinaus) oder genau an der Grenze gemeldet wird. Die Alarmseite zeigt pro Wert
den Messwert, das Ziel und „zu warm“, „zu feucht“ usw. Für Wassermelder und
Wassertanks schlägt die Alarmseite passende Alarme vor.

## Gießen und Wasser

Im Growplan unter **Protokoll → Erinnerungen**, je Zelt:

- **Erinnern nach Tagen ohne Gießung** (1–14 Tage, zu einer Uhrzeit), gemessen an der
  letzten Gießung im Protokoll.
- **Erinnern bei trockener Erde:** fällt die Bodenfeuchte (Mittel der Bodensonden im
  Zelt) eine halbe Stunde lang unter den eingestellten Wert, kommt eine Meldung,
  höchstens alle 12 Stunden.
- **Gießungen erkennen:** steigt die Bodenfeuchte deutlich an, schlägt GrowDeck unter
  **Heute** vor, die Gießung einzutragen (Datum und Uhrzeit sind schon gesetzt).
- **Tank fast leer:** Befeuchter mit Wasserstandsmeldung (z. B. AeroStream) melden
  sich, sobald sie nachgefüllt werden wollen.

Die Meldungen erscheinen im Ereignisprotokoll und – wenn „Gießen und Wasser“ unter
**Optionen → Benachrichtigungen** an ist – per Telegram oder Web-Adresse.

## Kameras, Fotos und Zeitraffer

Kameras werden unter **Optionen → Kameras** eingerichtet:

- **Vivosun GrowCam:** GrowDeck findet sie im Vivosun-Konto („Einrichten“). Nötig ist
  nur ihre IP-Adresse im Heimnetz (steht im Router, z. B. FRITZ!Box → Heimnetz →
  Netzwerk; am besten eine feste IP vergeben). Anmeldung und Port kommen aus dem
  Konto, das Bild wird per RTSP direkt im Heimnetz geholt.
- **Andere Kameras:** eine RTSP-Adresse (`rtsp://benutzer:passwort@ip:554/…`) oder die
  Adresse eines Standbilds (`http://…/snapshot.jpg`). Das Passwort wird in der
  Oberfläche nur maskiert angezeigt.

Jede Kamera fotografiert zu bis zu sechs Uhrzeiten am Tag, auf Wunsch nur bei Licht
(verpasste Zeiten werden bis zu zwei Stunden nachgeholt), und kann einem Zelt
zugeordnet werden. „Foto jetzt“ nimmt sofort auf. Die **Galerie** zeigt die Fotos
nach Monaten, groß mit Vor/Zurück, Herunterladen und Löschen. Der **Zeitraffer**
baut aus einem Foto pro Tag (oder allen Fotos) eines Zeitraums ein MP4-Video in drei
Tempi. Im Growplan zeigt **Heute** das letzte Foto des Zelts, und jeder
Protokolleintrag kann ein Foto bekommen („Jetzt fotografieren“ oder aus der Galerie).

Die Fotos liegen im Datenordner unter `photos/<kamera>/<datum>/` (bis Full HD,
je Foto etwa 0,2–0,6 MB samt Vorschau; ein Foto am Tag sind rund 15 MB im Monat). Wie lange sie aufgehoben werden, ist je Kamera
einstellbar (Standard: unbegrenzt). ffmpeg ist über `imageio-ffmpeg` im Image
enthalten; das Image wird dadurch etwa 70 MB größer.

## Grow-Archiv

**Grow abschließen** (im Growplan unter **Heute**) legt den laufenden Grow ins
**Archiv**: Plan und Einstellungen, das komplette Gießprotokoll, Erntedatum, Ertrag
(getrocknet, auch später nachtragbar), Sorten, Notizen und Bewertung. Dazu berechnet
GrowDeck Kennzahlen: Dauer von Wachstum und Blüte, Gramm pro Watt und pro kWh,
geschätzten Lampenstrom und Stromkosten (Lampenleistung × Dimmer × Lichtstunden),
Gießungen und Liter, mittlere EC/pH-Werte und das Klima je Phase (Mittel Tag/Nacht,
Anteil der Zeit im Ziel, Licht pro Tag, DLI). Die Klimawerte stammen aus
Tageszusammenfassungen, die GrowDeck jede Nacht anlegt und die länger halten als der
Verlauf. Auf Wunsch wird der Plan danach für den nächsten Grow zurückgesetzt
(Anzucht, Woche 1, Protokoll leer; Dünger, Lampe und Einstellungen bleiben).

Im Archiv lassen sich Grows nebeneinander vergleichen und das Protokoll als CSV oder
der ganze Grow als JSON herunterladen.

## Datensicherung

Unter **Optionen → Datensicherung** sichert GrowDeck jede Nacht (Standard 03:30)
die komplette Datenbank: Geräte-Zuordnungen, Räume, Regeln, Alarme, Growplans mit
Protokoll, Archiv, Einstellungen und Zugangsdaten. Die Sicherungen liegen
komprimiert im Datenordner unter `backups/`; die letzten 7 automatischen werden
aufgehoben (einstellbar), von Hand erstellte bleiben, bis du sie löschst. Fotos
gehören nicht dazu, sie liegen daneben unter `photos/`. Für eine Kopie außerhalb
der NAS den ganzen Ordner `data` in die Sicherung der NAS aufnehmen (auf ein anderes
Laufwerk oder in die Cloud).

„Wiederherstellen“ prüft die Sicherung, legt vorher eine Sicherung des aktuellen
Stands an und startet den Container neu (dank `restart: unless-stopped` ist er nach
wenigen Sekunden wieder da). Eine heruntergeladene Sicherung lässt sich über
„Sicherung hochladen“ auch auf einer anderen Installation einspielen.

## Sprache: Deutsch oder Englisch

- **Oberfläche:** GrowDeck folgt der Sprache des Browsers (Deutsch bei deutschem
  Browser, sonst Englisch). Unter **Optionen → Darstellung → Sprache · Language** lässt
  sie sich fest einstellen; die Wahl gilt für den jeweiligen Browser, jedes Gerät kann
  also eine eigene Sprache haben. Datum und Zahlen folgen der Sprache (2,5 bzw. 2.5);
  Eingabefelder nehmen beides an.
- **Meldungen:** Unter **Optionen → Benachrichtigungen → Sprache der Meldungen** wählen,
  ob Telegram und die Web-Adresse auf Deutsch oder Englisch schreiben. Voreinstellung
  ist Deutsch, `GD_LANGUAGE=en` in der Umgebung des Dienstes `growdeck` macht Englisch
  zur Voreinstellung.
- **Exporte:** Der CSV-Export des Gießprotokolls kommt in der Sprache der Seite (auf
  Englisch mit Kommas zwischen den Feldern und Dezimalpunkt). Growplan-Backups bleiben im
  Format der Growplan-App.
- Was du selbst benennst (Zelte, Geräte, Ausgänge, Regeln, Alarme, Pflanzen, Notizen),
  bleibt wie eingegeben. Ereignisse und Meldungen, die GrowDeck erzeugt, werden beim
  Anzeigen übersetzt, auch ältere Einträge im Ereignisprotokoll.

## Bedienung in Kürze

- **Übersicht:** pro Raum Temperatur, Luftfeuchte, VPD, CO₂ und PPFD, dazu ein
  VPD-Diagramm mit Zielbereich für die Phase (Setzlinge, Wachstum, Blüte, späte
  Blüte, Trocknung). Darunter der Verlauf von Temperatur, Luftfeuchte und VPD für
  6 Stunden, 24 Stunden oder 7 Tage (Auswahl oben rechts): drei Grafiken mit
  gemeinsamer Zeitachse, Mittelwerten für Tag und Nacht, grau hinterlegten Zeiten
  mit Licht aus (aus dem Schaltprotokoll der Lampen, sonst nach den Lichtzeiten
  des Raums) und den Zielbereichen (Growplan, Zeltsteuerung oder VPD-Richtwert der
  Phase) samt Anteil der Zeit, die der Wert darin lag.
  Die Werte gibt es auch als Tabelle. Ohne angelegten Raum zeigt die Übersicht
  Klima und Verlauf für alle Geräte zusammen. Darunter alle Geräte des Raums mit
  Messwerten und dem Zustand ihrer Ausgänge. Die Übersicht zeigt nur an; schalten
  und einstellen geht über „Bedienen“ in den Gerätedetails.
- **Geräte:** Details pro Gerät mit Schaltern und Reglern. Die Schieberegler (Stufe,
  Helligkeit, Spektrum) sind gesperrt, solange das Gerät nicht auf „Manuell“ (bei
  AC Infinity „An“ oder „Aus“) steht, also einen Zeitplan, Zyklus oder eine
  Automatik abarbeitet, oder solange die Zeltsteuerung die Stufe regelt. Neben dem
  Regler steht, warum er gesperrt ist; nach dem Umstellen des Modus lässt er sich
  wieder bewegen. Dasselbe gilt für „Auf … % stellen“ im Growplan unter Licht. Bei Spider Farmer „Zeitplan und Zyklus“,
  „Modus einrichten“ (Steckdosen) und „Klimaziele“; diese Einstellungen werden auf
  dem Gerät gespeichert und laufen auch ohne GrowDeck. Bei Vivosun die
  Automatik-Grenzen der Abluft, Zielwerte und Programme.
- **Verlauf:** beliebige Messwerte über 6 Stunden bis 30 Tage vergleichen.
- **Regeln:** Grenzwert (mit optionalem Nachtwert und Rückschaltabstand),
  Zeitfenster, Intervall und Zustand eines anderen Geräts. Prüfung alle 10 Sekunden. Steuern mehrere Regeln
  denselben Ausgang, gilt die weiter unten stehende.
- **Alarme:** untere und obere Grenze, Verzögerung in Minuten, Protokoll aller
  Ereignisse; dazu Growplan-Alarme (siehe oben).
- **Benachrichtigungen:** per Telegram und an eine Web-Adresse, als Text (z. B. ntfy:
  `https://ntfy.sh/dein-thema`) oder als JSON (Home Assistant, Node-RED). Unter
  **Optionen → Benachrichtigungen** lässt sich wählen, was gemeldet wird: Alarme und
  Entwarnungen (auch Growplan-Alarme), Gießen und Wasser (Erinnerungen, erkannte
  Gießungen, Tank fast leer), Geräte ohne Daten und wieder erreichbar, Fehler beim
  Schalten durch Regeln und Zeltsteuerung, Probleme mit Datensicherung und Kameras,
  auf Wunsch jeder Schaltvorgang. Meldungen desselben
  Moments kommen gebündelt, dieselbe Meldung höchstens einmal in 15 Minuten.

### Telegram einrichten

1. In Telegram **@BotFather** öffnen, `/newbot` senden, Namen und Benutzernamen
   für den Bot vergeben. BotFather antwortet mit dem Bot-Token.
2. In GrowDeck unter **Optionen → Benachrichtigungen → Telegram** den Token
   einfügen. Dem neuen Bot in Telegram eine Nachricht schicken (z. B. `/start`);
   für eine Gruppe den Bot in die Gruppe einladen und dort etwas schreiben.
3. „Chat suchen“ drücken und den Chat wählen. GrowDeck schickt sofort eine
   Testnachricht. Die Chat-ID lässt sich auch von Hand eintragen.

Die NAS braucht dafür Internet (`api.telegram.org`). Der Token liegt wie die
Zugangsdaten der Hersteller unverschlüsselt in der Datenbank; wer ihn kennt, kann
im Namen des Bots schreiben. Alternativ lassen sich `TELEGRAM_BOT_TOKEN` und
`TELEGRAM_CHAT_ID` als Umgebungsvariablen des Dienstes `growdeck` setzen.

Gut zu wissen: Wenn GrowDeck bei Spider Farmer einen Ausgang schaltet, wechselt
dieser Ausgang in den manuellen Modus. Anbaupläne aus den Hersteller-Apps können
Einstellungen später wieder überschreiben.

## Sicherheit

- Ein eigenes, starkes `APP_PASSWORD` setzen. Nach mehreren Fehlversuchen sperrt
  GrowDeck die Anmeldung kurz.
- GrowDeck nur im Heimnetz betreiben und nicht per Portfreigabe ins Internet
  stellen. Für den Zugriff unterwegs ein VPN nutzen (z. B. WireGuard am Router
  oder Tailscale).
- Der Mosquitto-Port 1883 ist nur im Docker-Netz erreichbar. Nach außen offen sind
  8080 (Weboberfläche), 8883 (Spider-Farmer-Module) und bei Weg A Port 53.

## Aktueller Stand und Grenzen

- Backend und Oberfläche sind vollständig gegen die eingebauten Simulatoren
  getestet: Spider-Farmer-Nachrichten über einen echten MQTT-Broker, die
  Vivosun-Cloud über eine nachgebildete Schnittstelle, Befehle, Regeln
  (auch herstellerübergreifend), Alarme, Verlauf, Live-Aktualisierung.
- Mit echter Hardware und echten Vivosun- oder AC-Infinity-Konten wurde GrowDeck
  noch nicht getestet. Der AC-Infinity-Client wurde zusätzlich gegen eine
  nachgebildete Schnittstelle mit Antworten im Originalformat geprüft
  (`backend/tests/test_acinfinity_client.py`). Die Protokolle beruhen auf dem Nachrichtenformat, das Schedule 4 Real
  verwendet, und auf der quelloffenen Home-Assistant-Integration für Vivosun.
  Feldnamen einzelner Geräte oder Firmwarestände können abweichen. Unter
  **Geräte → Fehlersuche** zeigt GrowDeck die Rohdaten jedes Geräts; damit lassen
  sich Abweichungen schnell finden.
- Das Docker-Projekt ist gegen die Compose-Spezifikation geprüft, aber in dieser
  Form noch nicht auf einer UGREEN-NAS gebaut worden.
- Die GrowCam wird nicht als Livebild eingebunden, sondern fotografiert zu festen
  Zeiten. Der RTSP-Abruf ist gegen Fehlerfälle und mit Standbild-Adressen getestet,
  aber noch nicht mit einer echten GrowCam.
- **GrowHub A10 / A22:** Das Datenformat dieser Steckdosen ist nirgends
  dokumentiert, auch die Home-Assistant-Integrationen unterstützen sie nicht.
  GrowDeck erkennt die Steckdosen an typischen Feldnamen und schaltet sie; die Demo
  nutzt ein angenommenes Format. Passt die Erkennung nicht, steht beim Gerät ein
  Hinweis und unter **Fehlersuche** die Rohdaten – damit lässt sich die Zuordnung
  nachziehen.

## Entwicklung

Backend (Python 3.12):

```sh
cd backend
pip install -r requirements.txt
GD_DATA_DIR=./data DEMO_MODE=1 APP_PASSWORD=test python -m uvicorn app.main:app --port 8088
```

Für die Spider-Farmer-Simulation im Demo-Modus braucht es einen MQTT-Broker auf
`127.0.0.1:1883` (z. B. `mosquitto`). Ohne Broker laufen nur die Vivosun-Geräte.

Frontend (Node 22):

```sh
cd frontend
npm ci
npm run dev        # http://localhost:5173, leitet /api an Port 8088 weiter
npm run build      # erzeugt frontend/dist
npm run build:demo # statische Live-Demo → frontend/dist-demo (GitHub Pages)
```

Tests (Backend):

```sh
python tests/test_acinfinity_client.py                   # AC-Infinity-Client gegen nachgebildete API
python tests/test_climate_history.py                     # Klimaverlauf und Licht-aus-Zeiten
python tests/test_growplan.py                            # Growplan: Pläne, Protokoll, Backups, Zeltsteuerung
python tests/test_features.py                            # Growplan-Alarme, Gießen, Datensicherung, Kameras, Archiv, A10/A22
python tests/test_i18n.py                                # englische Texte: Wörterbuch, Servertexte, CSV
python tests/test_notify.py                              # Benachrichtigungen, Telegram gegen nachgebildete API
python tests/smoke_api.py http://127.0.0.1:8088 test     # End-to-End gegen laufende Demo
```

Wichtige Umgebungsvariablen: `APP_PASSWORD`, `TZ`, `MQTT_HOST`, `MQTT_PORT`,
`SPIDERFARMER_ENABLED`, `VIVOSUN_EMAIL`, `VIVOSUN_PASSWORD`, `ACINFINITY_EMAIL`,
`ACINFINITY_PASSWORD`, `DEMO_MODE`,
`HISTORY_INTERVAL_SECONDS`, `RETENTION_DAYS`, `LOG_LEVEL`, `GD_DATA_DIR`,
`GD_STATIC_DIR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GD_LANGUAGE` (de oder en,
Voreinstellung für die Sprache der Meldungen).

Übersetzungen: Der deutsche Text ist der Schlüssel. `t('Zeitraffer')` aus
`frontend/src/i18n.js` liefert auf Englisch den Eintrag aus `frontend/src/i18n/en.json`
(Platzhalter wie `{name}` werden eingesetzt). Texte vom Server bleiben deutsch und werden
über dasselbe Wörterbuch übersetzt: Schlüssel mit Platzhaltern dienen als Muster
(„{name} ist offline.“). Das Backend nutzt die Datei für Telegram, Web-Adresse und
CSV-Export; im Image liegt sie als `app/i18n_en.json`. Neue Texte brauchen einen Eintrag in
`en.json`, sonst erscheinen sie auf Englisch deutsch.

Aufbau: `backend/app/adapters` enthält je Hersteller einen Adapter, der Geräte in
ein gemeinsames Modell aus Sensoren und Ausgängen übersetzt. Regeln, Alarme,
Verlauf und Oberfläche arbeiten nur mit diesem Modell. Ein weiterer Hersteller
braucht deshalb nur einen weiteren Adapter.

## Lizenzen

- Der Vivosun-Cloud-Client in `backend/app/adapters/vivosun/vendor` stammt aus
  [lientry/homeassistant-vivosun-growhub](https://github.com/lientry/homeassistant-vivosun-growhub)
  (MIT-Lizenz, siehe `LICENSE` und `VENDOR.md` in diesem Ordner) und wurde für
  GrowDeck von Home Assistant gelöst.
- Der AC-Infinity-Client in `backend/app/adapters/acinfinity/vendor` stammt aus
  [dalinicus/homeassistant-acinfinity](https://github.com/dalinicus/homeassistant-acinfinity)
  (MIT-Lizenz, siehe `LICENSE` und `VENDOR.md` dort), ebenfalls ohne
  Home-Assistant-Abhängigkeiten. Die Testdaten in `backend/tests/fixtures` sind aus
  den Tests dieses Projekts abgeleitet.
- Der `spiderproxy` wird nicht mitgeliefert (siehe oben).
- GrowDeck selbst steht unter der [MIT-Lizenz](LICENSE).
- GrowDeck ist ein unabhängiges Projekt und gehört nicht zu Spider Farmer, Vivosun oder AC Infinity.
