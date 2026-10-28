# RunningServer ↔ MarkerML2: Bedienung und Protokoll

**Stand: 27.10.2026.** Die vollständige Bedienungsanleitung steht in der [README](../README.md). Diese Datei beschreibt die aktuelle Unity-Schnittstelle. Neue Befehle benötigen einen entsprechend neu gebauten Client auf der Brille.

## Einrichtung

Serverordner: `/Users/kaan/RunningServer/`.

```bash
cd /Users/kaan/RunningServer
npm start
```

Dashboard: `http://localhost:8081/`. WebSocket: `ws://<Serveradresse>:8081/ws`.

Für USB:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
```

Die App verwendet standardmäßig `ws://127.0.0.1:8081/ws`. Für WLAN muss in `Assets/Resources/RunnerServer.json` die LAN-Adresse des Macs stehen; danach neu bauen. Eine `runner-server.json` in `Application.persistentDataPath` überschreibt diese Adresse ohne Neubau.

## Verbindung

Die Unity-App sendet nach dem WebSocket-Verbindungsaufbau:

```json
{"type":"hello","role":"headset","deviceId":"<Geräte-ID>","platform":"Magic Leap 2"}
```

Danach sendet sie `registry` mit `project: "MarkerML2"`, den unterstützten Befehlen und dem HUD `stadium`. Das Dashboard meldet sich als `role: "dashboard"` an. Ein Server unterstützt eine Brille und mehrere Dashboards.

Die App verbindet sich mit wachsender Wartezeit erneut. Ein Verbindungsabbruch pausiert die Session. Ausdrücklich mit **Weiter** fortsetzen. Während einer Trennung gesendete Befehle werden nicht nachgeholt.

## Befehl senden und Bestätigung lesen

Beispiel für unabhängiges festes Nutzertempo:

```bash
curl -X POST http://localhost:8081/api/command \
  -H 'Content-Type: application/json' \
  -d '{"commandType":"runningMate.setUserSpeed","commandPayload":{"source":"FixedTest","speedKmh":10}}'
```

HTTP 202 mit `commandId` bedeutet nur, dass der Server den Befehl zur Weiterleitung angenommen hat. Die Brille prüft und verarbeitet ihn auf dem Unity-Hauptthread und antwortet mit:

```json
{"type":"ack","commandId":"<ID>","success":true,"data":{"state":"Running"}}
```

Bei Fehlern: `success: false` und `error`. Fehlende Bestätigungen laufen nach zehn Sekunden ab. Ohne verbundene Brille liefert `/api/command` HTTP 503. Das Dashboard zeigt Befehle und Bestätigungen im Log. Es deaktiviert Funktionen, die der Client nicht in seiner Registry meldet.

## Unterstützte Befehle

| Befehl | Payload / Wirkung |
| --- | --- |
| `runningMate.configure` | Optional `paceSeconds` (180–1200), `mode` (`SideBySide`/`TempoPartner`), `showTrack` (Boolean). Setzt Session-Statistik/Ghost-Aufnahme zurück und pausiert. Pace betrifft den Avatar, nicht das Nutzertempo. |
| `runningMate.command` | `action`: `spawn`, `start`, `pause`, `resume`, `stop`, `reset`, `despawn`. `start`/`spawn` setzen Bahn 3; `resume` erhält die ausgewählte Bahn. |
| `runningMate.setLane` | `lane` als Ganzzahl 1–8. Gilt für beide Avatar-Modi. |
| `runningMate.setUserSpeed` | `source: "FixedTest"` mit `speedKmh` (0–100) oder `source: "Treadmill"`. In der echten Stadionumgebung nicht aktiv. Quellenwechsel erhält den Laufzustand und die Avatar-Pace. |
| `runningMate.setGhostSpeed` | `speedKmh`: nicht-negative endliche Zahl für unabhängiges Ghost-Testtempo; `null` stellt normale Bestzeit-/Zielpace-Wiedergabe wieder her. |
| `scene.setTrackEnvironment` | `environment: "Treadmill"` oder `"Stadium"`. Beginnt eine neue pausierte Session und setzt deren Statistik zurück. |
| `scene.rescanMarker` | `{}`. Pausiert, blendet Bahn/Avatar aus und wartet auf neuen Bodenmarker samt Plane. |
| `scene.captureTrackPoint` | `point: "A"` oder `"B"`; bei B optional `distanceAlongTrack` (5–100 m, Standard 20). |
| `runningMate.adjust` | Absolute `along`, `across` (je ±100 m), `heading` (±180°) oder `reset: true`. Werte relativ zur letzten Grundkalibrierung. |
| `avatar.configurePlacement` | Nur SideBySide in der Laufbandumgebung: `position` (N/NE/E/SE/S/SW/W/NW), `facing` (FaceUser/BackToUser/LeftShoulder/RightShoulder), `distance` (0,5–20 m). |
| `avatar.reposition` | `{}`. Blickausrichtung auf der bereits erkannten Bodenreferenz; im Stadionmodus A/B verwenden. |
| `scene.setRunningMatePathVisible` | `visible` (Boolean). Blendet die Bahn ein/aus. |
| `scene.setRunningMateHudVisible` | `visible` (Boolean). Blendet das Headset-HUD ein/aus. |
| `scene.setHudVisible` | `id: "stadium"`, `visible` (Boolean). |
| `sensor.connect` / `sensor.disconnect` | Vorhandene BLE-Komponente verwenden. Verbinden verlangt bereits entdeckte Geräte. Keine automatische neue BLE-Suche über diese Befehle. |

Kompatibilitätsbefehle bleiben im Code: `heightCm` bei `runningMate.configure`, `scene.recalibrate` mit `includeHeight` und `scene.adjustHeight` mit `deltaMetres`. Sie sind kein Bestandteil der aktuellen manuellen Höhenbedienung im Dashboard. Die Marker-/Plane-Platzierung verwendet keine Körpergrößenhöhe.

Kalibrierungs-, Platzierungs- und Bahnauswahlbefehle verlangen eine pausierte und gültig platzierte Session. Das Dashboard pausiert dafür vorab und wartet auf die Bestätigung. Geschwindigkeitsquellen- und Ghost-Tempoänderungen pausieren den laufenden Avatar dagegen nicht. Explizite Pause, Stoppen und Verbindungsabbruch frieren die Session ein.

Die Serverfamilien `avatar.*`, `scene.*`, `exercise.*`, `runningMate.*`, `sensor.*` sind ein Envelope-Filter. Daraus folgt keine Unterstützung aller generischen Avatar-/Übungsfunktionen. Die Unity-Registry und Handler sind maßgeblich.

## Geschwindigkeiten und Uhr

- **Nutzer-Testtempo:** frei eingestellte Nutzer-km/h; bewegt die virtuelle Welt.
- **Laufbandquelle:** zukünftiger Messwert-Eingang. Keine aktuelle Hardware-Anbindung. Ohne gültiges, höchstens zwei Sekunden altes Signal: 0 km/h Nutzerfortschritt.
- **Avatar:** eigene Zielpace, Bestzeitwiedergabe oder Ghost-Testgeschwindigkeit. Ein laufender Tempo-Partner läuft auch bei 0 km/h Nutzerfortschritt mit eigener Runden-Uhr über Rundengrenzen weiter, ohne auf den Nutzer zu warten. SideBySide behält die relative Nutzerposition und verwendet seine Zielpace für die Laufanimation.
- **Echte Stadionbahn:** feste Welt und aus Headtracking projizierter Nutzerfortschritt.

Die Session-Uhr läuft nach ausdrücklichem Start bei gültiger Platzierung auch dann, wenn das Nutzertempo 0 ist. Vor einem Start bleibt der automatisch erschienene Avatar stehen.

Ein späterer Laufband-Adapter liefert auf dem Unity-Hauptthread `ReportTreadmillSpeedKmh(...)` und meldet eine Trennung über `ClearTreadmillSignal()`. Diese API steuert keinen Laufbandmotor.

## Telemetrie

Unity sendet ungefähr mit 5 Hz ein `telemetry`-Objekt. Die aktuellen Laufwerte stehen in `data.treadmill`; `data.runningMate` enthält dieselben Daten zur Kompatibilität.

| Feld | Bedeutung |
| --- | --- |
| `state` | Stopped / Ready / Running / Paused |
| `distance`, `elapsed`, `laps` | Nutzerdistanz in Metern, Zeit in Sekunden, vollständige 400-m-Referenzrunden |
| `speedKmh`, `speed` | Nutzer-Geschwindigkeit in km/h bzw. m/s |
| `userSpeedSource` | FixedTest / Treadmill / HeadTracking |
| `fixedUserSpeedKmh`, `treadmillSignalReady` | Eingestelltes Testtempo und Frische des zukünftigen Laufbandsignals |
| `environment`, `avatarLane`, `mode` | Treadmill/Stadium, Bahn 1–8, SideBySide/TempoPartner |
| `headPoseReady`, `heightConfirmed`, `placementReady`, `trackVisible` | Tracking-/Platzierungsstatus und gewünschte Streckensichtbarkeit |
| `trackPositionMetres` | Position auf der 400-m-Referenzlinie |
| `markerPlacement` | `required`, `floorConfirmed`, `markerId`, lesbarer `status` |
| `calibration` | `along`, `across`, `heading`, `surfaceHeight` |
| `stadiumCalibration` | `pointA`, `calibrated`, `baselineMetres`, `raceStartTrackMetres` |
| `placement` | Sweet-Spot-Entwurf/Anwendung und `laneActive` |
| `ghost` | `active`, `distance`, `trackPositionMetres`, `speedKmh`, `gapMetres`, `testMode`, `testSpeedKmh`, `recordedLap` |
| `records` | `fastest100mSeconds`, `bestLapSeconds`, `fastest1KmSeconds`: gemessene Zeiten oder `null` |

Zusätzlich: `data.ble.connected` und `data.huds.stadium`. Aktuell werden keine vollständigen BLE-Vitalwerte oder Übungserkennungen von dieser Brücke geliefert. Verschachtelte Objekte im Relay werden ersetzt; der Client sendet vollständige Teilobjekte.

## Sessions und Dateien

Server-Session und Unity-Lauf sind getrennte Abläufe. HTTP-Endpunkte:

- `GET /api/status`, `GET /api/registry`
- `POST /api/command`
- `POST /api/session/start` mit optionalem `name`, `POST /api/session/stop`
- `POST /api/recording/start`, `POST /api/recording/stop`

Aufnahmen liegen in `RunningServer/recordings/<ID>/`: `ble_data.csv`, `exercise_detections.csv`, `commands.jsonl`, `session_meta.json`. Es gibt noch keinen eigenen Export für Laufbahnpositionen oder Rekordzeiten. Bei `Ctrl+C` wird eine aktive Aufnahme geordnet abgeschlossen.

## Geprüfter Stand

Der Marker-/Floor-Ray-Spawn wurde mit Marker 39 auf der Magic Leap 2 bestätigt: `floorConfirmed: true`, `placementReady: true`, `avatarLane: 3`, `ghost.active: true`, gestoppte Session. Die danach ergänzte Geschwindigkeitsquellen-Auswahl und unabhängige Pace-Anpassung sind kompiliert/getestet, aber noch nicht im zuletzt installierten Build enthalten. Die feste reale 400-m-Bahn und echte Laufband-Hardware sind noch nicht durch einen vollständigen Geräte-Lauf verifiziert.
