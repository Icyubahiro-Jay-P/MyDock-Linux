# Performance

How much CPU, GPU and memory MyDock costs, measured against no dock and against the docks the installer turns off (Ubuntu Dock, Dash2Dock Lite).

**Short version:** when idle, MyDock costs nothing measurable. While you actively use the dock it adds about 9% of one CPU core, and most of that is icon magnification. Turning off **Magnify on hover** brings it close to Ubuntu Dock.

## Test setup

| | |
|---|---|
| MyDock | 1.2.3 (commit `6a1f631`) |
| GNOME Shell | 46.0, Wayland |
| CPU | Intel Core i5-6300U (2 cores / 4 threads) |
| GPU | Intel HD Graphics 520 |
| RAM | 8 GB |
| Screen | 1920x1080 virtual monitor |
| Date | 2026-10-06 |

Each run starts a **fresh headless GNOME Shell** with its own D-Bus session and its own empty settings, so runs don't affect each other or the real desktop. Only the dock under test and a small benchmark helper extension are enabled. Docks use their default settings unless noted.

Every run has two 40-45 second phases:

- **Idle:** nothing happens on screen.
- **Workload:** the same scripted activity for every dock, repeated every 6 seconds:
  - a virtual mouse sweeps along the bottom and left screen edges, which hovers the dock and triggers magnification and autohide;
  - every window is minimized, then restored;
  - three windows stay open while two more open and close.

What is measured:

| Metric | Source |
|---|---|
| CPU | user + system time of the test `gnome-shell` process, as % of one core. The machine has 4 threads, so 100% = one quarter of total CPU. |
| GPU busy | `1 - RC6 residency` from `/sys/class/drm/card1/gt/gt0/rc6_residency_ms`. This covers the whole GPU, including the real desktop, so it is noisier than CPU. Medians are reported. |
| Memory | `VmRSS` of the test `gnome-shell` process at the end of each phase. |

## Results

### MyDock compared with other docks

3-4 valid rounds per dock. "Extra" is the cost above the no-dock baseline.

| Dock | Idle CPU % | Workload CPU % | Extra workload CPU | Idle memory, MB |
|---|---|---|---|---|
| No dock (baseline) | 2.08 | 19.70 | - | 233.2 |
| Ubuntu Dock | 2.47 | 21.13 | +1.4 | 230.2 |
| **MyDock** | **2.41** | **28.13** | **+8.4** | **244.0** |
| Dash2Dock Lite | 5.43 | 44.54* | +24.8* | 239.8 |

\* Dash2Dock Lite crashed its headless test shell in 3 of 4 workload runs, so this figure is from the one run that finished. The crashes may be specific to headless mode.

### What each MyDock feature costs

Each line turns off one feature, or several in the case of "lean". Workload CPU in % of one core, 4 runs unless noted. The baseline and Ubuntu Dock were measured again in this series.

| Setup | Average | Min to max | Extra over no dock |
|---|---|---|---|
| No dock (baseline, 3 runs) | 20.99 | 20.90 to 21.09 | - |
| Ubuntu Dock (3 runs) | 20.02 | 18.97 to 20.94 | about 0 (-2.0 to 0) |
| MyDock, default settings | 29.87 | 26.76 to 31.71 | **+8.9** (+5.8 to +10.7) |
| MyDock, blur off | 28.42 | 26.92 to 30.31 | +7.4 (+5.9 to +9.3) |
| MyDock, minimize effect "none" | 29.41 | 28.44 to 31.02 | +8.4 (+7.5 to +10.0) |
| MyDock, minimize effect "scale" (3 runs) | 30.62 | 30.14 to 31.46 | +9.6 (+9.2 to +10.5) |
| MyDock, **magnify off** | 23.80 | 23.27 to 24.57 | **+2.8** (+2.3 to +3.6) |
| MyDock, lean (blur, magnify, minimize effect all off) | 23.37 | 22.07 to 24.19 | +2.4 (+1.1 to +3.2) |
| MyDock, a real user's config (live blur, "suck" effect, autohide, menu bar stats) | 30.07 | 29.59 to 30.51 | +9.1 (+8.6 to +9.5) |

Cost of each feature, worked out as default minus feature off:

| Feature | CPU, points of one core | GPU busy, points |
|---|---|---|
| **Magnify on hover** | **~6.1** | ~3.7 |
| Blur (dock + menu bar) | ~1.5 (within noise) | ~1.6 |
| Genie minimize vs none | ~0.5 (within noise) | ~0 |

GPU busy during the workload, median:

| Setup | GPU % |
|---|---|
| No dock | ~7.9 |
| Ubuntu Dock | ~7.4 |
| MyDock default | ~14.8 |
| MyDock, blur off | ~13.2 |
| MyDock, magnify off | ~11.1 |
| MyDock, lean | ~10.8 |

**Idle:** every setup measured 2.1-3.0% CPU, and the no-dock baseline itself ranged from 1.65% to 5.24%. MyDock has no measurable idle cost.

**Memory:** MyDock adds 10-12 MB to GNOME Shell (244.6 MB vs 232.8 MB with no dock). That doesn't change with settings, since it comes from the code for the dock, menu bar, Launchpad, Stage Manager and calendar.

## Takeaways

- MyDock is about as cheap as Ubuntu Dock when idle, and much cheaper than Dash2Dock Lite under load.
- Under activity, about 70% of MyDock's extra CPU is **magnification**. If you're on a low-power laptop, turning off *Magnify on hover* is the single most effective setting.
- Blur and the genie effect are cheap. Turning them off saves little.

## Caveats

- These results are from one machine. Absolute numbers will differ on other hardware, but the ratios between setups should hold.
- Headless shells render off-screen. On a real display, GPU cost scales with resolution and refresh rate.
- 5 of 72 runs in the feature series were dropped: in 4 the extension had not finished loading when checked, and in 1 the baseline shell crashed. Some GPU readings were inflated by other apps running on the real desktop, which is why GPU figures are medians.
