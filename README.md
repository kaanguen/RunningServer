# Avatar VOS — Dashboard & Server

A browser-based remote control panel for the Avatar VOS experience running on Magic Leap 2.
You open the dashboard on any computer or tablet on the same Wi-Fi network, and it lets you control everything about the avatar in real time — where it stands, how it moves, what it looks like, and how it reacts to the person wearing the headset.

---

## Implementation status and target platform

The Node.js service and browser dashboard are implemented in this repository for **Magic Leap 2**. The service serves the dashboard, forwards commands to one connected headset, broadcasts telemetry to multiple dashboards, tracks acknowledgements, and records sensor data and commands locally.

The **Unity headset application is a separate integration** and is not included here. Tracking, marker calibration, avatar behavior, rendering and BLE sensor access must be implemented by that application. The new [WebSocket protocol and command catalog](docs/PROTOCOL.md) define the integration contract used by this service. No existing Unity `AvatarFSM.md` was available to verify payload compatibility.

- Use Node.js 22 or newer.
- Configure the Unity client with `ws://<server-LAN-IP>:8080/ws` and send a `hello` message with role `headset` before sending registry or telemetry.
- The dashboard uses headset-neutral labels. Automatic lighting calibration is enabled only if the client advertises `ambientLightCalibration` support; ARKit is not used by this service.
- This is an unauthenticated, trusted-LAN service. Do not expose it directly to the internet.

## Quick start

```bash
npm install        # first time only
node server.js
```

Open a browser and go to the address printed in the terminal, for example:

```
http://192.168.1.42:8080
```

Open `http://localhost:8080` on the server computer. Use the printed LAN address from other devices. The Magic Leap 2 app must be configured to connect to the same server address over WebSocket and implement the [protocol](docs/PROTOCOL.md).

```bash
npm test              # integration tests (HTTP, WebSocket, recording)
npm run simulate      # separate terminal: synthetic headset for testing
```

The simulator supplies synthetic telemetry and acknowledges only its implemented command subset; other commands explicitly fail. Stop it before connecting a physical headset. A successful simulator test does not verify Magic Leap hardware integration.

Configure the server with `PORT` and `HOST` if needed, for example `PORT=8081 HOST=127.0.0.1 npm start`. By default it listens on all interfaces on port 8080.

```text
server.js                    HTTP API, WebSocket relay, recording
public/                      dashboard (HTML, CSS, JavaScript)
scripts/simulate-headset.js   synthetic integration client
test/service.test.js         service integration tests
docs/PROTOCOL.md             Unity client contract
recordings/                  runtime data (git-ignored)
```

---

## How it works

```
┌─────────────────┐        WebSocket        ┌──────────────────┐
│  Dashboard      │ ◄─────────────────────► │  Node.js server  │
│  (browser)      │      (port 8080)         │  server.js       │
└─────────────────┘                          └────────┬─────────┘
                                                      │ WebSocket
                                             ┌────────▼─────────┐
                                             │ Magic Leap 2 app │
                                             │     (Unity)      │
                                             └──────────────────┘
```

- The **dashboard** (this web page) connects to the server over WebSocket and sends commands when you press buttons or move sliders.
- The **server** receives those commands and forwards them to the Magic Leap 2 headset.
- The **Magic Leap 2 app** receives commands, moves the avatar, and sends back live telemetry (position, state, sensor readings).
- Everything is broadcast — multiple dashboards can be open at the same time and all stay in sync.

---

## Status bar (top of every page)

The coloured dots at the top tell you the current connection state at a glance.

| Dot | What it means |
|-----|---------------|
| **WS** | Dashboard is connected to the server |
| **Headset** (legacy label: **AVP**) | The Magic Leap 2 headset is connected to the server |
| **Avatar** | An avatar is currently in the scene |
| **Floor** | Floor marker ("Marker A") has been calibrated |
| **Dir B** | The second marker ("Marker B") / heading has been calibrated — used by the Running Mate stadium setup to know which way the track runs |
| **BLE** | A Bluetooth health sensor (Polar) is connected |
| **REC** | A recording session is active |

The **avatar ID chip** shows which avatar all commands are currently targeting.
The **Last Ack** area shows whether the last command succeeded or failed.

---

## Tab: Avatar

Everything about where the avatar stands and how it moves.

### Avatar ID

Each avatar has a unique ID (like `alex_v1`). When the Magic Leap 2 connects it sends a list of available avatars — buttons appear automatically. Click one to select it, or type an ID manually.

### Spawn / Despawn

**Spawn** places the avatar in the scene. Before spawning you choose:

- **Start locomotion** — how the avatar moves when it first appears (see Locomotion modes below)
- **Start behavior** — how it acts when it first appears (see Behavior states below)

**Despawn** removes the avatar from the scene completely.

**Spawn on Object** — type the exact name of a physical object in the Unity scene and the avatar appears on top of it.

### Sweet Spot Placement

The "sweet spot" is the ideal position where the avatar should stand relative to the person in the headset.

| Control | What it does |
|---------|-------------|
| **Position** | Which side of the user the avatar stands on — N = in front, S = behind, E = right, W = left, etc. This direction is locked to where the user was looking when the avatar was spawned. |
| **Facing** | Which way the avatar looks — Face User (looks at you), Back To User, Left Shoulder, Right Shoulder |
| **Distance** | How far away the avatar stands (metres) |
| **Pos Tol** | How precisely the avatar tracks its target — smaller = more precise but more movement |
| **Smooth** | How gradually the target position updates as the user moves |
| **Reposition** | Instantly move the avatar to the ideal spot in front of the user right now, and lock it there. Also resets the reference direction. |

### Turning

Controls when and how the avatar turns to face the user.

| Control | What it does |
|---------|-------------|
| **Tolerance** | Angle the avatar ignores — small head movements within this range cause no reaction |
| **Trigger** | How far off-axis the user needs to stand before a turn-step animation plays |
| **Delay** | How long the user needs to be misaligned before the avatar reacts |
| **Residual** | How fast the avatar quietly corrects tiny leftover angles after a turn, without a full step animation |

### Movement

Controls walking speed and distance when the avatar is following the user.

| Control | What it does |
|---------|-------------|
| **Speed** | Walking speed (metres per second) |
| **Back ×** | Speed when stepping backward, as a fraction of forward speed |
| **Anim ×** | Walk animation playback speed — adjust to match animation to actual speed |
| **Stop at** | Personal space boundary — avatar stops walking this close to the user |
| **Follow delay** | (Reaction mode only) How long the user must stay in a new spot before the avatar walks to follow. Higher = more natural companion feel. |
| **Lock Y** | Keep the avatar planted on the floor — prevents floating or sinking |

### Reaction Gate

A distance window that controls when the avatar is "active" vs. "idle" in Reaction mode.

| Control | What it does |
|---------|-------------|
| **Min** | Inside this distance the avatar ignores the user (prevents it reacting when you're right next to it) |
| **Max** | Beyond this distance the avatar also ignores the user |
| **Hyst** | A small safety buffer that stops the avatar flickering at the edge of the zone |

### Step Back on Touch

When enabled, if the user walks too close the avatar plays a step-back animation.

| Control | What it does |
|---------|-------------|
| **Enable on touch** | Turn the step-back reflex on or off |
| **Touch** | How close the user needs to walk before the step-back triggers |
| **Dist** | How far the avatar steps back |
| **Anim ×** | How fast the step-back animation plays |

### Sweet Spot Diagram

A live bird's-eye diagram that visualises all the placement parameters at once.
Updates instantly as you move the sliders. Useful for understanding how the different zones relate to each other.

---

## Tab: Behavior

Controls the avatar's personality and how it moves around.

### Behavior State

The behavior state controls *how* the avatar acts. Only one state is active at a time.

| State | What it does |
|-------|-------------|
| **Idle** | Avatar stands completely still — does not turn or react |
| **Exercise** | Avatar performs an exercise animation in place — does not follow or turn |
| **Turn In Place** | Avatar turns to face you once and holds — stays at its anchor, does not follow |
| **Reaction** | Full companion mode — turns to face you, follows at a comfortable distance, steps back if you get too close. **Default after spawning.** |
| **Stimulus** | Freezes the avatar — no behavior or movement changes are allowed until released. Used for triggered events like pain reactions. |

Priority order: **Stimulus > Reaction > TurnInPlace > Exercise > Idle**

### Locomotion Mode

The locomotion mode controls *where* the avatar moves. It works independently of the behavior state.

| Mode | What it does |
|------|-------------|
| **Locked In Place** | Avatar stays pinned at its current position. Use Reposition to move it. |
| **Sweet Spot Follow** | Avatar continuously walks to stay at the sweet spot as the user moves around |
| **Approach User (sustained)** | Avatar keeps pace with the user, always staying at the stop distance. Stays active until you change mode. |
| **Go to User (one-shot)** | Avatar walks to the user once, stops at the personal boundary, then locks in place. Uses the dedicated GotoUser walk animation. |
| **Step-back toggle** | Quickly enable or disable the step-back reflex |

> **Note:** Some behavior + locomotion combinations don't work together. The dashboard disables the unavailable options automatically and shows an explanation when this happens.

### Shader

Switch the avatar's visual appearance. Buttons are auto-populated from the catalog when the headset connects.

### Thermal

Control the thermal body shader — shows the avatar's body as a heat map, like a thermal camera.

| Control | What it does |
|---------|-------------|
| Preset buttons | Quick presets: Normal Body, Fever, Hypothermia, Cold/Warm Ambient, High Contrast, FLIR |
| **Temperature slider** | Manually set a sensor temperature (°C) and push it to the avatar |

### Animation

Play one of the avatar's looping expressive animations. Buttons are auto-populated when the headset connects. You can also type an exact animator state name and press Play.

### Head Look

Toggle whether the avatar's head tracks the user's position in real time.

### TV Static

Apply a TV static / noise shader to the avatar — useful for glitch effects.


---

## Tab: Status & Sensors

A read-only overview of the current state of everything.

### Avatar State

Shows the current behavior state, locomotion mode, and other avatar settings as reported back from the headset. Updates live.

### BLE Health Sensor

Live readings from a connected Bluetooth sensor (Polar ring or similar).

| Metric | What it shows |
|--------|--------------|
| **HR** | Heart rate (beats per minute) |
| **Temp** | Body temperature (°C) |
| **SpO₂** | Blood oxygen saturation (%) |
| **PR** | Pulse rate from oximeter |
| **PI** | Perfusion index — ratio of pulsatile to non-pulsatile blood flow |

**Connect / Disconnect** buttons start and stop the Bluetooth scan.

### Session Recording

Start and stop recording sessions. When recording is active, all BLE sensor data, exercise detections, and commands sent are written to a timestamped folder in `recordings/` on the server.

---

## Tab: Exercises

Live display of exercise detection results. The app analyses the user's movements in real time and rates each exercise profile for confidence and intensity.

Each card shows:
- **Confidence** — how well the current movement matches the exercise
- **Intensity** — how strongly the movement is expressed (drives healing / visual effects on the avatar)
- **Frequency / Amplitude** — raw signal characteristics
- **Active** indicator — lights up green when this profile is the top match

Use the **Active Profile** selector to manually override which exercise profile is active.

---

## Tab: Scene

Control the lighting and shadow in the scene.

### Scene Lighting

| Control | What it does |
|---------|-------------|
| Preset buttons | Quick lighting setups — Natural, Overhead, Left/Right, Front, Rim, Dim, Off |
| **Pitch** | Elevation angle of the light — negative = from above |
| **Yaw** | Horizontal angle — 0 = front, 90 = right |
| **Intensity** | Brightness (0 = off, 1 = normal, 3 = very bright) |
| **Color** | Light tint colour |
| **Calibrate** buttons | Request ambient light calibration; the Unity client must provide a Magic Leap 2-compatible implementation before this control is enabled |

### Shadow

Toggle and fine-tune the grounding shadow plane beneath the avatar.

### HUDs in the headset

The person in the headset sees floating information panels (HUDs) around them — for example a stadium/lap panel, or debug read-outs. This card lets you show or hide each of those panels remotely.

The buttons are **auto-discovered**: the headset broadcasts a list of every registered panel when it connects, and one button appears per panel. A **highlighted button means the panel is currently visible** on the headset; click to toggle it. If the list is empty you'll see "waiting for AVP HUD registry" until the headset reports in.

> The same show/hide capability also appears inside the feature tabs it belongs to (for example the Running Mate tab has its own **Headset HUD** (legacy label: **AVP HUD**) show/hide for the stadium panel), so you can control a panel from wherever you happen to be working.

---

## Tab: Running Mate

A "virtual running coach" mode: a coach avatar runs laps on a **real athletics track** at a target pace, so the person wearing the headset can chase it or pace off it. Because the coach has to line up with the actual painted lanes of a physical stadium, this tab is mostly about **calibrating** the app to the real track, then **configuring and running** the coach.

The tab has two sub-views, switched by the **Controls** / **Track view** buttons at the top:

- **Controls** — all the setup and run buttons (default).
- **Track view** — a full-page bird's-eye stadium diagram showing the coach's live position.

### Stadium calibration (the two-marker setup)

Before the coach can run in the right place, the app needs to learn two things about the real track: **where the start line is** and **which direction the lane runs**. You teach it this by looking at two physical spots, in order:

1. **Marker A** — stand on the finish/start line in lane 1 and look down at the floor until the **Floor** status dot turns green. This anchors the track's origin.
2. **Marker B** — walk ~15–30 m further along the *same* lane in the running direction (counter-clockwise) and look at that spot for a couple of seconds until the **Dir B** dot turns green. The line from A to B tells the app which way the track is oriented ("run yaw").
3. Turn on **Ground path** (see Run controls) and walk the lane — the white guide lines drawn on the floor should sit neatly between the real painted lines. If they drift, re-place Marker B further away for a longer, more accurate baseline.

The panel shows the live calibration read-out: **Marker A**, **Marker B**, the **Baseline** distance between them, and the resulting **Run yaw** (heading angle).

### Fine adjust path

Even after calibration, the virtual lanes can be a few centimetres or degrees off the real paint. These buttons nudge the whole path without re-doing calibration:

| Row | What it does |
|-----|-------------|
| **Along track** | Slide the path forward/backward along the running direction (±1 cm / ±10 cm steps) |
| **Across track** | Slide the path sideways, toward or away from the infield (±1 cm / ±10 cm) |
| **Heading** | Rotate the whole path a fraction of a degree either way (±0.5° / ±1°) |
| **Reset** | Clear all nudges and return to the raw calibrated path |

The running **Offset** total (e.g. `5cm · -2cm · 0.5°`) is shown so you can see how far you've adjusted.

### Config

Defines *who* runs, *where*, and *how fast*. Press **Configure** to validate and apply it on the headset; the acknowledgement line reports the computed lap length, speed, and animation multiplier (or an error).

| Control | What it does |
|---------|-------------|
| **Avatar** | Which coach avatar to use. It must have a looping "Run" animation. The list auto-fills from the headset's catalog; `coach_default_01` is the default. |
| **Mode** | The pacing strategy — **Target Pacer** runs at a pace you set; **Previous Time Pacer** re-runs a previously recorded lap time so the runner can race their past self |
| **Lane (1–8)** | Which lane the coach runs in (1 = innermost/shortest, 8 = outermost/longest). The lane changes the lap distance. |
| **Start slot (0–7)** | Where on the track the coach starts, in eighths of a lap. Each slot shows a plain-language hint and, where relevant, the sign painted on a real track at that spot (e.g. slot 0 = "ZIEL · Start 400m Bahn 1"). |
| **Target time / Previous time** | Time to complete one lap. Accepts either plain seconds (`80`) or `mm:ss` (`1:20`). The label changes to match the selected mode. |
| **Anim name** | The animator state to play while running (default `Run`) |
| **Ref speed (m/s)** | The speed the run animation was authored for. The app scales the footstep cadence up or down from this so the feet match the actual running speed. |

### Run controls

Drive the coach once it's configured:

| Button | What it does |
|--------|-------------|
| **Spawn** | Place the coach at the chosen lane/slot, standing still |
| **Start** | Begin running at the configured pace |
| **Pause** / **Resume** | Freeze the coach in place / continue — lap timing stays accurate across a pause |
| **Stop** | Stop running but leave the coach where it is |
| **Reset** | Snap the coach back to the start slot, ready to Start again |
| **Despawn** | Remove the coach entirely |

Below the buttons are three live tuning/visibility controls:

| Control | What it does |
|---------|-------------|
| **Anim ×** | Live "foot-skate" fix. While the coach runs, drag this until the planted foot stops sliding on the floor. **Auto** clears the manual override and goes back to the calculated speed. |
| **Headset HUD** (legacy label: **AVP HUD**) | Show/hide the floating stadium panel *inside the headset* |
| **Ground path** | Show/hide the lane guide lines drawn on the real floor — use it to check calibration by walking the lane |

### Status

A live read-out from the coach: current **State**, the **Anchor** source (which marker the position is based on), **Lap length**, **Speed**, **Elapsed** time, **Distance** covered, and **Laps** completed.

### Track view

A full-page top-down stadium graphic that updates in real time:

- **Cyan dot** — the coach's live position on the track
- **Yellow ring** — the selected start slot
- **Yellow dashed line** — the selected lane
- The whole diagram **rotates to match the real track's heading**, so it lines up with what you'd see standing at the marker.

---

## Log panel (right side)

A real-time log of all commands sent and messages received. Useful for debugging.
Use the **Auto-scroll**, **Clear**, and **Copy** buttons at the top.
Click the arrow button to collapse the log panel and give more space to the controls.

---

## Recordings

Recording files are saved in `recordings/<timestamp>/` on the server:

| File | Contents |
|------|----------|
| `ble_data.csv` | BLE sensor readings with timestamps |
| `exercise_detections.csv` | Exercise profile detections with timestamps |
| `commands.jsonl` | All commands sent during the session |
| `session_meta.json` | Session ID and metadata |

---

## Sending commands manually

Every button and slider in the dashboard sends a JSON command to the server via HTTP POST to `/api/command`, which the server forwards to the headset over WebSocket.

A command looks like this:

```json
{
  "commandType": "avatar.setBehaviorState",
  "targetId": "alex_v1",
  "commandPayload": {
    "behaviorState": "Reaction"
  }
}
```

You can send commands directly from any tool (curl, Postman, your own code):

```bash
curl -X POST http://192.168.1.42:8080/api/command \
  -H "Content-Type: application/json" \
  -d '{"commandType":"avatar.setBehaviorState","targetId":"alex_v1","commandPayload":{"behaviorState":"Reaction"}}'
```

Common command families:

| Prefix | Used by | Examples |
|--------|---------|----------|
| `avatar.*` | Avatar / Behavior tabs | `avatar.spawn`, `avatar.setBehaviorState`, `avatar.setMode`, `avatar.configurePlacement`, `avatar.playAnimation` |
| `scene.*` | Scene tab | `scene.setLight`, `scene.setShadow`, `scene.setHudVisible`, `scene.setRunningMateHudVisible`, `scene.setRunningMatePathVisible` |
| `sensor.*` | Sensor controls | `sensor.connect`, `sensor.disconnect` |
| `exercise.*` | Exercises tab | `exercise.setActiveProfile` |
| `runningMate.*` | Running Mate tab | `runningMate.configure`, `runningMate.command`, `runningMate.adjust`, `runningMate.tune` |

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the implemented command envelope, dashboard payload fields, and telemetry schema. Reconcile these fields with `Instructions/AvatarFSM.md` when integrating an existing Unity project.

---

## API endpoints

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/api/command` | POST | Send a command to the headset |
| `/api/status` | GET | Current connection state and avatar registry |
| `/api/registry` | GET | Last received catalog snapshot (avatar IDs, shader names, etc.) |
| `/api/session/start` | POST | Start a named session |
| `/api/session/stop` | POST | End the current session |
| `/api/recording/start` | POST | Start recording to disk |
| `/api/recording/stop` | POST | Stop the active recording |

## iPad dashboard

The dashboard supports iPad portrait and landscape layouts with touch-sized controls, two-column cards where space allows, and a compact top navigation on tablet widths. The event log starts collapsed; its visibility preference is saved per browser. Heart and liver controls are omitted from the dashboard.

Start the server with `npm start`, connect the iPad to the same local network, and open the printed **LAN** URL in Safari (for example `http://192.168.1.42:8080`). `localhost` on the iPad refers to the iPad itself, not the server computer. Multiple dashboards can connect simultaneously.
