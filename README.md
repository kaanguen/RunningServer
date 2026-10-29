# RunningServer

ML2 Projekt

**Stand: 27.10.2026.** Lokaler Node.js-Server für die Magic-Leap-2-App MarkerML2. Er liefert das Dashboard aus, leitet Befehle an die Brille weiter, verteilt deren Live-Daten und verwaltet Server-Sessions sowie Aufzeichnungen.

Die Unity-App berechnet Marker-/Plane-Platzierung, Bewegung, Ghost und Rekorde. Die Webseite allein aktualisiert diese Funktionen nicht auf der Brille: Neue Unity-Befehle verlangen einen neuen App-Build.

## Was wird benötigt?

- Node.js **22 oder neuer** und npm auf dem Serverrechner.
- Magic Leap 2 mit installierter MarkerML2-App.
- USB-Datenverbindung mit ADB oder ein erreichbares gemeinsames Netzwerk.
- Ein zur App passender AprilTag: aktuelle Szene **36H11**, konfigurierte Kantenlänge **10 cm**, flach auf dem Boden.
- Auf der Brille erlaubtes Marker Tracking und Spatial Mapping sowie gültiges Headtracking.

Die vollständige Anwendungsanleitung liegt im Unity-Projekt unter `/Users/kaan/Unity Projekte/MarkerML2/README.md`. Das aktuelle Protokoll steht in [docs/unity-protocol.md](docs/unity-protocol.md).

## Server starten

```bash
cd /Users/kaan/RunningServer
npm install
npm start
```

`npm install` ist nur bei fehlenden oder geänderten Abhängigkeiten nötig. Das Terminal für den laufenden Server geöffnet lassen. Stoppen mit **Ctrl+C**.

Dashboard: **http://localhost:8081/**

Der Standardport ist 8081. Port 8080 wurde auf diesem Rechner bereits von Unity MCP verwendet. Ein anderer Port lässt sich mit `PORT` setzen; die Adresse in der App und gegebenenfalls die USB-Weiterleitung müssen dann ebenfalls passen.

```bash
PORT=8082 npm start
```

`HOST` überschreibt die standardmäßige Bindung an `0.0.0.0`. Der Server ist für das lokale Netzwerk gedacht und besitzt keine Anmeldung/TLS; ihn nicht öffentlich ins Internet freigeben.

## Brille verbinden

### Über USB

Developer Mode und USB debugging auf der Magic Leap aktivieren, Compute Pack anschließen und die Debugging-Freigabe in der Brille bestätigen. Auf dem Mac:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
```

Die App verwendet dabei `ws://127.0.0.1:8081/ws`. Das funktioniert auf der Brille durch die Portweiterleitung zum Mac. Bei `unauthorized` die Freigabe bestätigen. Bei mehreren Geräten `adb -s <Seriennummer> ...` verwenden. USB angeschlossen lassen und die Weiterleitung nach einem Neustart erneut setzen.

### Über WLAN

Beim Serverstart die ausgegebene LAN-IP ablesen. In der Unity-Datei `Assets/Resources/RunnerServer.json` eintragen und die App neu bauen/installieren:

```json
{
  "serverUrl": "ws://<LAN-IP-des-Serverrechners>:8081/ws"
}
```

`localhost` auf der Brille bezeichnet die Brille, nicht den Mac. Die Datei `runner-server.json` im `Application.persistentDataPath` der App kann die im Build hinterlegte Adresse überschreiben.

## App bedienen

1. App aufsetzen/öffnen und auf den verbundenen MarkerML2-Status warten.
2. Bodenmarker scannen und die Plane um den Marker erfassen. Bahn und Avatar erscheinen automatisch auf der erkannten Bodenhöhe; Startbahn ist **3**. Keine Körpergrößeneingabe nötig.
3. **An Brille senden** überträgt Ghost-Zielpace, Avatar-Modus und Streckensichtbarkeit. Das setzt die Session-Statistik zurück. **Lokal speichern** speichert nur einen Browserentwurf.
4. Nutzertempo auswählen und übernehmen. Feste Test-km/h simulieren den Nutzer. Die Laufbandquelle ist für spätere Sensordaten vorbereitet und liefert ohne Signal 0 km/h.
5. **Lauf starten** startet eine gültig platzierte Session. **Pause**, **Weiter**, **Stoppen** und **Lauf zurücksetzen** sind getrennte Aktionen.

### Bereiche

| Bereich | Funktionen |
| --- | --- |
| Laufband | Session-Konfiguration, Nutzertempo, Laufsteuerung, Live-Bahnkarte, Ghost-Testtempo und Rekorde |
| Kalibrierung | Marker-/Plane-Status, erneutes Scannen, Umgebung, Avatar-Bahn 1–8, A/B-Stadionkalibrierung, Sweet Spot und Feinversätze |
| Sensoren & Session | BLE-Verbindungsstatus, Server-Session und Aufzeichnung |
| Log | Verbindungen, gesendete Befehle und Bestätigungen der Brille |

### Nutzer und Avatar haben getrennte Geschwindigkeiten

- **Nutzer-Testtempo:** feste Nutzer-km/h; die virtuelle Welt bewegt sich bei räumlich stehendem Nutzer.
- **Laufbandquelle:** später gemessene Bandgeschwindigkeit. Ohne aktuelle Werte bzw. nach zwei Sekunden ohne gültiges Signal: 0 km/h Nutzerfortschritt. Ein echter Hardware-Adapter ist noch nicht implementiert.
- **Tempo-Partner:** eigene Zielpace, Bestzeitprofil oder Ghost-Testtempo. Er läuft in einer gestarteten Session weiter, auch wenn das Nutzertempo 0 ist oder auf Laufbanddaten umgestellt wird. Seine eigene Runden-Uhr lässt ihn auch über Rundengrenzen weiterlaufen, ohne auf den Nutzer zu warten.
- **Side by Side:** bleibt relativ beim Nutzer; seine Laufanimation verwendet die eingestellte Avatar-Pace unabhängig vom Laufbandsignal.

Der Wechsel der Nutzerquelle pausiert den Avatar nicht. Explizite Pause/Stoppen und ein Verbindungsabbruch frieren die Session weiterhin ein. Vor „Lauf starten“ steht der automatisch erschienene Avatar still.

Die neue Nutzerquellen-Auswahl und die unabhängige Pace-Anpassung sind im Quellcode/Dashboard vorhanden, aber noch nicht im zuletzt auf der Brille geprüften Marker-Build enthalten. Bis zur Installation eines neuen Builds sind entsprechende Knöpfe deaktiviert.

### Avatar-Bahn und Stadionkalibrierung

Die Bahnwahl 1–8 gilt für beide Avatar-Modi. Automatischer Spawn, erneuter Markerscan und „Lauf starten“ setzen Bahn 3. Danach kann die Bahn geändert werden; „Weiter“ erhält die Auswahl.

Für eine reale Standard-400-m-Bahn **Echte 400-m-Bahn** wählen: Die Welt bleibt fest, Nutzerfortschritt stammt vom Headtracking. Der Umgebungswechsel beginnt eine neue pausierte Session. Nach Marker-/Plane-Platzierung lassen sich Punkt A an der gemeinsamen Start-/Ziellinie von Bahn 1 und Punkt B eine bekannte Strecke von 5–100 m weiter gegen den Uhrzeigersinn erfassen. Die Strecke entlang der Messlinie muss vor Ort bestimmt werden. Die Einpassung verschiebt und dreht das Standardoval ohne Skalierung.

Die ganze Bahn lässt sich entlang/quer mit Zentimeter-/Meter-Schritten oder absoluten Versätzen bis ±100 m sowie mit einer Drehung bis ±180° justieren. Kalibrierungsaktionen pausieren automatisch. Bodenhöhe kommt aus der Plane; manuelle Höhenfelder sind entfernt.

### Ghost und Rekorde

Das Ghost-Testtempo überschreibt nur den Ghost. 0 km/h hält ihn an; **Zurück zur Bestzeit** aktiviert wieder die aufgezeichnete beste vollständige Runde – auch wenn diese langsamer als die Zielpace war. Fehlt eine Aufnahme, heißt der Knopf **Zurück zur Zielpace**. Ein pausierter Lauf bleibt beim Umschalten pausiert.

Die Rekordkarte zeigt tatsächlich gemessene vollständige 100-m-, 400-m- und 1-km-Zeiten der aktuellen App-Session. Ziel-/Beispielzeiten zählen nicht. Reset, Umgebungswechsel oder App-Neustart löschen diese Session-Werte. Änderungen an Pace, Modus und Bahnsichtbarkeit erhalten Laufdaten und Ghost-Aufnahme; der Lauf wird dabei pausiert. Eine dauerhafte persönliche Rekorddatenbank ist nicht implementiert.

## Server-Sessions und Aufzeichnung

Eine Server-Session anlegen startet keinen Unity-Lauf. Eine Aufnahme kann mit oder ohne benannte Server-Session laufen. Vor dem Beenden einer Session die Aufnahme stoppen.

Unter `recordings/<ID>/` entstehen:

- `ble_data.csv`
- `exercise_detections.csv`
- `commands.jsonl`
- `session_meta.json`

Der aktuelle Unity-Client überträgt BLE-Verbindungsstatus, aber noch keine vollständigen Vitalwert-/Übungsdaten. Leere Sensoraufnahmen sind deshalb möglich. Laufbahnpositionen und Rekorde haben noch keinen eigenen CSV-Export. Beim geordneten Serverstopp wird eine aktive Aufnahme abgeschlossen.

## Entwicklung und Prüfung

```bash
npm test
node --check public/app.js
```

`npm test` umfasst sechs HTTP-/WebSocket-Integrationstests. `npm run dev` startet den Server mit Node-Watch. Der vorhandene Headset-Simulator liefert Testdaten und ersetzt keinen Magic-Leap-Gerätetest.

Die Marker-/Floor-Ray-Platzierung wurde mit Marker 39 auf der Magic Leap bestätigt. Ein vollständiger realer 400-m-Lauf und eine echte Laufband-Anbindung sind noch nicht verifiziert.

## Fehlersuche

- **Alter Seitenstand:** korrekten Serverordner und Port verwenden, Webseite neu laden.
- **Neue Funktion deaktiviert:** Brillenverbindung und gemeldete Client-Befehle prüfen; App gegebenenfalls neu bauen/installieren.
- **Marker erkannt, Bahn fehlt:** Markerstatus zeigt fehlende Floor-Plane, unvollständiges Polygon oder Tracking-Probleme. Ein stabiler Scan wartet auf die Plane-Erkennung.
- **Keine Verbindung:** App tragen/öffnen, USB-Freigabe, `adb reverse` oder LAN-IP prüfen.
- **Nutzer bei 0 km/h:** Ohne angebundenes Laufband ist das in der Laufbandquelle erwartet; feste Test-km/h wählen.
- **Ghost läuft trotz Nutzerstillstand:** Erwartet: Der Avatar hat eine eigene Pace. Zum Anhalten ausdrücklich pausieren oder stoppen.

## Behaviour – Avatar-Animationen

Der eigene Tab **Behaviour** steuert die Animationen des Jogger-Avatars in MarkerML2.
Verfügbar sind die originalen Mixamo-Clips Arme & Beine aufwärmen aus Batter On Deck (17,03 s; ohne Schlägerhalten und Schlagen) und
Jumping Jacks (1,67 s pro Zyklus; Mixamo-Öffnungsbewegung mit umgekehrtem Rückweg, fortlaufend bis zum Stoppen)
Zusätzlich gibt es Warming Up · ohne Schläge (2,07 s; bis vor die Faustschläge),
Auch Arm Stretching · Arme dehnen (8,87 s) und Air Squat · Kniebeugen (1,87 s)
stehen zur Auswahl; sowie Stehen, Gehen, Joggen und Sprinten als Bewegungsvorschau am Platz.

1. Die aktualisierte MarkerML2-App auf der Brille starten und mit dem Server verbinden.
2. Unter Kalibrierung Bodenmarker und Avatar-Platzierung einrichten.
3. Behaviour öffnen, optional Wiederholung und Abspieltempo (0,25–2×) einstellen.
4. Bei einem Clip Abspielen wählen. Ein laufender Lauf wird pausiert; Distanz,
   Laufzeit und Bestzeiten bleiben erhalten. Die Animation läuft am aktuellen
   Begleiter – Side by Side oder Tempo-Partner – ohne Root Motion.
5. Zur Laufbewegung beendet die manuelle Auswahl. Der Lauf bleibt pausiert;
   im Tab Laufband mit Fortsetzen weiterlaufen.

Ohne Wiederholung endet die Auswahl nach einer Clip-Länge automatisch. Laufstart,
Fortsetzen, Stoppen, Reset und Verbindungsabbruch beenden ebenfalls die manuelle
Animation. Fehlende/alte App-Versionen und fehlende Clips werden gesperrt angezeigt.
Erfolgsmeldungen erscheinen erst nach der Bestätigung aus Unity.

Das Dashboard allein aktualisiert die Unity-App nicht. Für die Brille ist nach
Übernahme der Unity-Änderungen ein neuer Build erforderlich.


Plank ist im Behaviour-Tab als einzelner Ablauf verfügbar: Start Plank → 10 Sekunden Halten → End Plank. Bei Normaltempo dauert die Sequenz einschließlich Überblendungen etwa 18,34 Sekunden. Wiederholung startet danach den kompletten Ablauf neu.


Die Plank-Haltedauer lässt sich im Behaviour-Tab im Feld „Plank halten · Sekunden“ vor dem Abspielen auf 1–300 Sekunden einstellen. Standard ist 10. Bei Normaltempo entspricht die Eingabe der realen Haltezeit; Tempo 2× halbiert sie. Die Änderung gilt ab dem nächsten Abspielen. Dafür die aktualisierte Unity-App mit den drei Plank-States verwenden.


Lauf beenden: Die Server-Schaltfläche „Lauf beenden“ stoppt den Avatar dort, wo er sich gerade befindet. Er dreht sich zum Nutzer, spielt die bereitgestellte Mixamo-Animation Standing Thumbs Up einmal ab und bleibt danach zum Nutzer ausgerichtet. Zeit und Distanzen bleiben erhalten. „Lauf zurücksetzen“ ist getrennt: Beide Laufpartner beginnen wieder bei null, ohne Abschlussgeste; Bestzeiten werden erhalten.


## Warm-up vor dem Lauf

Im Tab **Warm-up** die Reihenfolge, Übungen und Dauer festlegen. Verfügbar sind
Warming Up ohne Schläge, Arm Stretching, Arme & Beine aufwärmen, Air Squat und
Jumping Jacks. Plank ist ausgeschlossen. Bis zu 20 Schritte mit jeweils 5–300
ganzen Sekunden sind möglich; derselbe Clip darf mehrfach vorkommen.
**Ablauf speichern** speichert den Entwurf in diesem Browser. **Warm-up starten**
überträgt eine vollständige Kopie an die Brille, die den Ablauf selbst abspielt.
Die Dauer ist echte Zeit bei normalem Animationstempo.

Vorher Bodenmarker und Platzierung einrichten. Beim Start geradeaus schauen:
Der Avatar steht 2,5 m vor der Startposition des Headsets, zum Nutzer gedreht,
auf der erkannten Bodenebene. Er bleibt dort stehen, wenn der Nutzer den Kopf
bewegt. Oben im Sichtfeld erscheinen **Warm UP**, Übung und Restzeit. Das
funktioniert mit Side by Side und Tempo-Partner. Laufzeit und Distanz bleiben
bei null; die gespeicherte Avatar-Bahn bleibt erhalten.

**Nächste Übung** überspringt den aktuellen Schritt. **Warm-up beenden** beendet
den Modus. Nach dem letzten Schritt blendet die Bewegung zu Idle über. Ein
Lauf startet erst über die Laufsteuerung; dabei wird die gewählte Bahn wieder
verwendet. Bei einem vorherigen Lauf zuerst **Lauf zurücksetzen**. Verlust von
Tracking/Platzierung, App-Pause oder Serververbindung beendet das Warm-up.
Zum Ändern der Platzierung oder Abspielen einer manuellen Behaviour-Animation
zuerst das aktive Warm-up beenden. Sprachansagen sind noch nicht enthalten.

Die Unity-App neu bauen und auf der Brille installieren. Prüfung im Editor:
**Tools > Jogger > Checks > Check Warm-up mode**. Die Implementierung wird beim
App-Start automatisch installiert; Szenen müssen nicht von Hand geändert werden.

Protokoll: `exercise.startWarmup` mit
`{"steps":[{"animationId":"Mixamo_ArmStretching","seconds":30}]}`;
`exercise.nextWarmup` und `exercise.stopWarmup` mit leerem Payload.
Die Registry meldet diese Commands und `warmupSequence`; Status und tatsächlicher
Fortschritt stehen unter `telemetry.treadmill.warmup`.
