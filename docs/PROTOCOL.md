# Magic Leap 2 / Unity client protocol (v1)

This is the wire contract implemented by this repository. No Unity project or existing
`Instructions/AvatarFSM.md` was supplied. Command names and payload fields below are
therefore the proposed integration contract; reconcile them with the real Unity
handlers before connecting an existing app. The server relays commands and does not
implement tracking, rendering, BLE access, calibration or avatar logic itself.

## Connect

Connect the Unity client to `ws://<server-LAN-IP>:8080/ws` (root `/` also accepts upgrades).
Use the computer's LAN IP, not `localhost`, on the headset. Both devices must be able
to reach each other on the local network. Set up the client's Android network access
and any project-specific cleartext-WebSocket policy. Use a WebSocket implementation
supported by the Unity version and Magic Leap project you actually use.

Within five seconds send:

```json
{"type":"hello","role":"headset","deviceId":"ml2-01","platform":"Magic Leap 2"}
```

The server responds with `welcome` (`protocolVersion: 1`) and a `status` snapshot.
Only one headset may connect at a time; a second connection closes with code 1008.
Dashboards send `{"type":"hello","role":"dashboard"}`. They receive status,
registry, telemetry, command and ack broadcasts; they send commands over HTTP.

The server uses WebSocket ping/pong every 15 seconds to detect stale sockets.
The client library must answer pings. Implement client reconnect with backoff and
send a fresh catalog and complete telemetry after reconnecting. The server never
replays commands that were sent while the headset was disconnected.

## Registry

Send a complete catalog on connection and whenever its contents change:

```json
{
  "type":"registry",
  "data":{
    "avatars":["coach_default_01","alex_v1"],
    "shaders":["Standard","Thermal"],
    "animations":["Idle","Run","Wave"],
    "exerciseProfiles":["Walking","Squat"],
    "huds":["stadium","debug"],
    "capabilities":{"ambientLightCalibration":false}
  }
}
```

Catalog entries may also be objects with an `id` or `name`. Enable ambient light
calibration only when the ML2 client really implements it. The dashboard has no
ARKit dependency.

## Commands and acknowledgements

`POST /api/command` accepts the command object described in the README and returns
HTTP 202 with a generated `commandId`. This means accepted for forwarding; it is
not confirmation of successful execution. With no connected headset it returns 503.

The headset receives:

```json
{
  "type":"command",
  "commandId":"server-generated-uuid",
  "timestamp":"2026-10-27T12:00:00.000Z",
  "commandType":"avatar.setBehaviorState",
  "targetId":"alex_v1",
  "commandPayload":{"behaviorState":"Reaction"}
}
```

Apply the command on Unity's main thread as appropriate. Validate avatar IDs,
values, supported features and state transitions in the Unity handler. Always reply:

```json
{"type":"ack","commandId":"server-generated-uuid","success":true,"data":{}}
```

For failure send `success: false` and an `error` string. Missing acknowledgements
fail after 10 seconds; disconnects fail outstanding commands immediately. Unknown
or late acknowledgement IDs are rejected. Use command IDs to avoid applying a
command twice if your client adds its own retry logic. The server does not retry.

### Dashboard command catalog

All commands carry the selected `targetId`, except configuration of a running coach,
which carries the coach ID entered in the form. Units are metres, seconds and degrees.

| Command | Payload fields |
| --- | --- |
| `avatar.spawn` | `locomotionMode`, `behaviorState` |
| `avatar.despawn` | none |
| `avatar.spawnOnObject` | `objectName` |
| `avatar.reposition` | none |
| `avatar.configurePlacement` | `position` (N/NE/E/SE/S/SW/W/NW), `facing` (FaceUser/BackToUser/LeftShoulder/RightShoulder), `distance`, `positionTolerance`, `smoothing` |
| `avatar.configureTurning` | `tolerance`, `trigger`, `delay`, `residualSpeed` |
| `avatar.configureMovement` | `speed`, `backwardMultiplier`, `animationMultiplier`, `stopDistance`, `followDelay`, `lockY` |
| `avatar.configureReactionGate` | `min`, `max`, `hysteresis` |
| `avatar.configureStepBack` | `enabled`, `touchDistance`, `distance`, `animationMultiplier` |
| `avatar.setBehaviorState` | `behaviorState`: Idle / Exercise / TurnInPlace / Reaction / Stimulus |
| `avatar.setMode` | `mode`: LockedInPlace / SweetSpotFollow / ApproachUser / GotoUser |
| `avatar.setShader` | `shader` |
| `avatar.playAnimation` | `animation` |
| `avatar.setThermal` | `preset` or `temperature` |
| `avatar.setHeadLook`, `avatar.setTvStatic` | `enabled` |
| `sensor.connect`, `sensor.disconnect` | none |
| `exercise.setActiveProfile` | `profile` (null for automatic) |
| `scene.setLight` | `preset` or `pitch`, `yaw`, `intensity`, `color` (#rrggbb) |
| `scene.calibrateLight` | none; requires capability |
| `scene.setShadow` | `visible`, optional `opacity`, `size` |
| `scene.setHudVisible` | `id`, `visible` |
| `scene.setRunningMateHudVisible`, `scene.setRunningMatePathVisible` | `visible` |
| `runningMate.configure` | `avatarId`, `mode`: TargetPacer / PreviousTimePacer; `lane` (1–8), `startSlot` (0–7), `targetTime`, `previousTime`, `animation`, `referenceSpeed` |
| `runningMate.command` | `action`: spawn / start / pause / resume / stop / reset / despawn |
| `runningMate.adjust` | absolute `along`, `across`, `heading` offsets relative to calibration, or `reset: true` |
| `runningMate.tune` | `animationMultiplier` (null restores automatic) |

The relay validates the envelope and the allowed command families, not the full
Unity-specific payload. The client is authoritative for command support and ranges.
Scene and sensor commands can ignore `targetId`. The dashboard disables incompatible
locomotion choices based on the selected behavior; the client must also enforce
its actual state machine.

## Telemetry

Send at a suitable rate (for example 2–10 Hz). Top-level fields are merged with the
last snapshot. Nested objects are replaced, so send complete nested objects.
Timestamps on recordings are generated by the server on receipt.

```json
{
  "type":"telemetry",
  "data":{
    "avatar":{"id":"coach_default_01","spawned":true,"behaviorState":"Reaction","locomotionMode":"LockedInPlace"},
    "calibration":{"markerA":true,"markerB":true,"baseline":20,"runYaw":0},
    "ble":{"connected":true,"hr":80,"temperature":36.7,"spo2":98,"pr":80,"pi":3.1},
    "exercises":[{"profile":"Walking","confidence":0.86,"intensity":0.45,"frequency":1.3,"amplitude":0.2,"active":true}],
    "huds":{"stadium":true,"debug":false},
    "runningMate":{"state":"Running","anchor":"MarkerA","lane":1,"startSlot":0,"lapLength":400,"speed":5,"elapsed":12,"distance":60,"laps":0}
  }
}
```

The track graphic is schematic, not a surveyed stadium map. It derives lap position
from distance/lapLength and startSlot and rotates with runYaw. Marker detection and
world placement must be implemented on the headset.

## Sessions and recordings

`POST /api/session/start` takes an optional `name`. Session start/stop and recording
start/stop use `{}` when no fields are needed. Duplicate starts return 409. Stop an
active recording before ending its session. Recording without a named session is
supported. Concurrent dashboards share one session and one recording.

Each recording directory contains `ble_data.csv`, `exercise_detections.csv`,
`commands.jsonl`, and `session_meta.json`. Metadata includes start/stop times and
the named session when present. Writes are ordered. Graceful SIGINT/SIGTERM shutdown
finalizes metadata; forced termination or power loss may leave a recording unfinished.
Only telemetry fields received during recording are written. The event stream and
acknowledgements are not persisted to `commands.jsonl`.

This is a trusted-LAN service without authentication, TLS or user accounts. Do not
expose port 8080 to the public internet. Cross-origin browser requests are rejected;
this is not authentication. Sensor data is stored locally in plaintext. Maximum
HTTP JSON body and WebSocket message size is 64 KiB. One active headset and multiple
dashboards are supported; separate headset sessions require separate server instances.
