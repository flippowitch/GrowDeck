"""Holds all runtime components and knows how to (re)configure integrations."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from .adapters.acinfinity.adapter import ACInfinityAdapter
from .adapters.acinfinity.cloud import ACInfinityCloud
from .adapters.acinfinity.fake import FakeACInfinityClient
from .adapters.mqtt_bus import MqttBus
from .adapters.sf_sim import SpiderFarmerSimulator
from .adapters.spiderfarmer import SpiderFarmerAdapter
from .adapters.vivosun.adapter import VivosunAdapter
from .adapters.vivosun.cloud import VivosunCloud
from .adapters.vivosun.fake import FakeVivosunCloud
from .alarms import AlarmEngine
from .archive import ArchiveService
from .auth import Auth
from .automation import AutomationEngine
from .backup import BackupService, apply_pending_restore
from .cameras import CameraError, CameraService
from .config import Settings
from .db import Database
from .events import EventBus
from .growplan import GrowPlanError, GrowPlanService
from .history import HistoryRecorder
from .hub import Hub
from .notify import Notifier
from .roomcontrol import RoomControl
from .watering import WateringService

_LOGGER = logging.getLogger(__name__)
VERSION = "1.6.1"


@dataclass
class AppContext:
    settings: Settings
    db: Database
    bus: EventBus
    hub: Hub
    auth: Auth
    automation: AutomationEngine
    room_control: RoomControl
    alarms: AlarmEngine
    notifier: Notifier
    history: HistoryRecorder
    growplan: GrowPlanService
    watering: WateringService
    backup: BackupService
    cameras: CameraService
    archive: ArchiveService
    sf_sim: SpiderFarmerSimulator | None = None
    started_at: float = field(default_factory=time.time)

    # ------------------------------------------------------------- build/start
    @classmethod
    async def create(cls, settings: Settings) -> AppContext:
        restored = apply_pending_restore(settings.data_dir, settings.db_path)
        db = Database(settings.db_path)
        await db.open()
        bus = EventBus()
        hub = Hub(db, bus)
        demo = settings.simulate_spiderfarmer or settings.simulate_vivosun or settings.simulate_acinfinity
        ctx = cls(
            settings=settings,
            db=db,
            bus=bus,
            hub=hub,
            auth=Auth(settings.app_password, settings.session_secret),
            automation=AutomationEngine(hub, settings.timezone),
            room_control=RoomControl(hub, settings.timezone),
            alarms=AlarmEngine(hub, settings.timezone),
            notifier=Notifier(hub, env_token=settings.telegram_token, env_chat_id=settings.telegram_chat_id),
            history=HistoryRecorder(hub, settings.history_interval, settings.retention_days),
            growplan=GrowPlanService(db, bus, settings.timezone),
            watering=WateringService(hub, settings.timezone),
            backup=BackupService(hub, settings.data_dir, settings.db_path, settings.timezone),
            cameras=CameraService(hub, settings.data_dir, settings.timezone, demo=demo),
            archive=ArchiveService(hub, settings.timezone, settings.retention_days),
        )
        ctx.backup.restored_at_start = restored
        if settings.spiderfarmer_enabled or settings.simulate_spiderfarmer:
            sim_macs: set[str] = set()
            if settings.simulate_spiderfarmer:
                ctx.sf_sim = SpiderFarmerSimulator(
                    MqttBus(settings.mqtt_host, settings.mqtt_port, username=settings.mqtt_username,
                            password=settings.mqtt_password, client_prefix="growdeck-sfsim"))
                sim_macs = ctx.sf_sim.macs
            hub.register_adapter(SpiderFarmerAdapter(
                MqttBus(settings.mqtt_host, settings.mqtt_port, username=settings.mqtt_username,
                        password=settings.mqtt_password, client_prefix="growdeck-sf"),
                simulated_macs=sim_macs,
            ))
        vivosun = await ctx._make_vivosun_adapter()
        if vivosun is not None:
            hub.register_adapter(vivosun)
        acinfinity = await ctx._make_acinfinity_adapter()
        if acinfinity is not None:
            hub.register_adapter(acinfinity)
        return ctx

    async def start(self) -> None:
        if self.sf_sim is not None:
            await self.sf_sim.start()
        await self.notifier.start()  # listens before anything can report an event
        await self.hub.start()
        await self.automation.start()
        self.automation.managed = self.room_control.managed
        await self.growplan.start()
        self.room_control.plan_targets = self.growplan.targets_for_room
        self.growplan.on_change = self.room_control.wake
        await self.room_control.start()
        # services that look at tents, plans and the room control
        self.alarms.growplan = self.watering.growplan = self.archive.growplan = self.growplan
        self.alarms.room_control = self.cameras.room_control = self.archive.room_control = self.room_control
        self.archive.watering = self.watering
        self.archive.cameras = self.cameras
        await self.alarms.start()
        await self.history.start()
        await self.watering.start()
        await self.cameras.start()
        await self.backup.start()
        await self.archive.start()
        if self.settings.simulate_spiderfarmer or self.settings.simulate_vivosun or self.settings.simulate_acinfinity:
            await self.seed_demo()

    async def stop(self) -> None:
        await self.archive.stop()
        await self.backup.stop()
        await self.cameras.stop()
        await self.watering.stop()
        await self.history.stop()
        await self.alarms.stop()
        await self.room_control.stop()
        await self.growplan.stop()
        await self.automation.stop()
        await self.hub.stop()
        await self.notifier.stop()
        if self.sf_sim is not None:
            await self.sf_sim.stop()
        await self.db.close()

    # ----------------------------------------------------------------- vivosun
    async def vivosun_credentials(self) -> tuple[str | None, str | None, str]:
        email = await self.db.get_setting("vivosun_email")
        password = await self.db.get_setting("vivosun_password")
        if email and password:
            return email, password, "app"
        if self.settings.vivosun_email and self.settings.vivosun_password:
            return self.settings.vivosun_email, self.settings.vivosun_password, "env"
        return None, None, "none"

    async def _make_vivosun_adapter(self) -> VivosunAdapter | None:
        if self.settings.simulate_vivosun:
            return VivosunAdapter(FakeVivosunCloud())
        email, password, _ = await self.vivosun_credentials()
        if not email or not password:
            return None
        interval = int(await self.db.get_setting("vivosun_poll_seconds", 60) or 60)
        return VivosunAdapter(VivosunCloud(email, password, poll_interval=interval))

    async def reconfigure_vivosun(self) -> None:
        old = self.hub.adapters.pop("vivosun", None)
        if old is not None:
            await old.stop()
            for device_id in [d.id for d in self.hub.devices.values() if d.vendor == "vivosun"]:
                self.hub.remove_device(device_id)
        adapter = await self._make_vivosun_adapter()
        if adapter is not None:
            self.hub.register_adapter(adapter)
            await adapter.start(self.hub)

    # ------------------------------------------------------------------ status
    async def acinfinity_credentials(self) -> tuple[str | None, str | None, str]:
        email = await self.db.get_setting("acinfinity_email")
        password = await self.db.get_setting("acinfinity_password")
        if email and password:
            return email, password, "app"
        if self.settings.acinfinity_email and self.settings.acinfinity_password:
            return self.settings.acinfinity_email, self.settings.acinfinity_password, "env"
        return None, None, "none"

    async def _make_acinfinity_adapter(self) -> ACInfinityAdapter | None:
        interval = int(await self.db.get_setting("acinfinity_poll_seconds", 10) or 10)
        if self.settings.simulate_acinfinity:
            return ACInfinityAdapter(ACInfinityCloud(poll_interval=interval, client=FakeACInfinityClient()))
        email, password, _ = await self.acinfinity_credentials()
        if not email or not password:
            return None
        return ACInfinityAdapter(ACInfinityCloud(email, password, poll_interval=interval))

    async def reconfigure_acinfinity(self) -> None:
        old = self.hub.adapters.pop("acinfinity", None)
        if old is not None:
            await old.stop()
            for device_id in [d.id for d in self.hub.devices.values() if d.vendor == "acinfinity"]:
                self.hub.remove_device(device_id)
        adapter = await self._make_acinfinity_adapter()
        if adapter is not None:
            self.hub.register_adapter(adapter)
            await adapter.start(self.hub)

    async def integrations(self) -> dict[str, Any]:
        sf = self.hub.adapters.get("spiderfarmer")
        vs = self.hub.adapters.get("vivosun")
        email, _, source = await self.vivosun_credentials()
        vs_status = vs.status() if vs else {"vendor": "vivosun", "title": "Vivosun", "state": "not_configured"}
        vs_status.update({
            "email": email,
            "credentials_source": source,
            "simulated": self.settings.simulate_vivosun,
        })
        sf_status = sf.status() if sf else {"vendor": "spiderfarmer", "title": "Spider Farmer",
                                            "state": "disabled"}
        sf_status["simulated"] = self.settings.simulate_spiderfarmer
        aci = self.hub.adapters.get("acinfinity")
        aci_email, _, aci_source = await self.acinfinity_credentials()
        aci_status = aci.status() if aci else {"vendor": "acinfinity", "title": "AC Infinity",
                                                "state": "not_configured"}
        aci_status.update({
            "email": aci_email,
            "credentials_source": aci_source,
            "simulated": self.settings.simulate_acinfinity,
        })
        return {"spiderfarmer": sf_status, "vivosun": vs_status, "acinfinity": aci_status}

    # -------------------------------------------------------------------- demo
    async def seed_demo(self) -> None:
        if await self.db.get_setting("demo_seeded"):
            return
        await self.db.save_room({"id": "zelt-1", "name": "Zelt 1", "sort": 0,
                                 "climate_device_id": "sf-5ff0cb000001", "climate_group": "Zelt",
                                 "day_start": "06:00", "day_end": "18:00", "stage": "flower"})
        await self.db.save_room({"id": "zelt-2", "name": "Zelt 2", "sort": 1,
                                 "climate_device_id": "vs-900000000000000101", "climate_group": "Zelt",
                                 "day_start": "06:00", "day_end": "00:00", "stage": "veg"})
        await self.db.save_room({"id": "trocknung", "name": "Trocknung", "sort": 3,
                                 "climate_device_id": "vs-900000000000000106", "climate_group": "Box",
                                 "day_start": "00:00", "day_end": "00:00", "stage": "dry"})
        placement = {
            "sf-5ff0cb000001": "zelt-1", "sf-5ff0a5000002": "zelt-1", "sf-5ff0aa000003": "zelt-1",
            "sf-5ff01c000004": "zelt-1", "vs-900000000000000101": "zelt-2",
            "vs-900000000000000102": "zelt-2", "vs-900000000000000103": "zelt-2",
            "vs-900000000000000104": "zelt-2", "vs-900000000000000105": "zelt-2",
            "vs-900000000000000107": "zelt-2", "vs-900000000000000106": "trocknung",
            "vs-900000000000000108": "zelt-2", "vs-900000000000000109": "zelt-2",
        }
        if self.settings.simulate_acinfinity:
            await self.db.save_room({"id": "zelt-3", "name": "Zelt 3", "sort": 2,
                                     "climate_device_id": "aci-3101000000000000001", "climate_group": "Zelt",
                                     "day_start": "06:00", "day_end": "00:00", "stage": "veg"})
            placement.update({"aci-3101000000000000001": "zelt-3", "aci-3101000000000000002": "zelt-3",
                              "aci-3101000000000000003": "zelt-3"})
        if self.settings.simulate_vivosun and self.settings.simulate_spiderfarmer:
            # Zelt 1 mixes all vendors: Spider Farmer controller and light, Vivosun humidifier
            # and dehumidifier, AC Infinity exhaust and clip fan
            placement.update({"vs-900000000000000102": "zelt-1", "vs-900000000000000104": "zelt-1"})
            if self.settings.simulate_acinfinity:
                placement["aci-3101000000000000002"] = "zelt-1"
        for device_id, room_id in placement.items():
            await self.db.update_device_meta(device_id, room_id=room_id)
        self.hub.meta = await self.db.all_device_meta()
        for device_id in placement:
            self.hub._reapply(device_id)  # noqa: SLF001 - intentional refresh of overlay
        if self.settings.simulate_vivosun and self.settings.simulate_spiderfarmer:
            await self.automation.save_rule({
                "name": "Zusatzlüfter, solange der Entfeuchter läuft",
                "enabled": True,
                "trigger": {"type": "device_state", "device_id": "vs-900000000000000104",
                            "control_id": "dhmdf", "state": "on"},
                "target": {"device_id": "sf-5ff0a5000002", "control_id": "O2"},
                "active_action": {"on": True},
                "inactive_action": {"on": False},
                "enforce": False,
            })
        if self.settings.simulate_spiderfarmer:
            await self.automation.save_rule({
                "name": "Umluft-Intervall an Steckdose 6",
                "enabled": False,
                "trigger": {"type": "cycle", "on_minutes": 15, "off_minutes": 45,
                            "start": "06:00", "end": "18:00"},
                "target": {"device_id": "sf-5ff0aa000003", "control_id": "O6"},
                "active_action": {"on": True},
                "inactive_action": {"on": False},
                "enforce": False,
            })
            await self.alarms.save({"name": "Zelt 1 zu warm", "device_id": "sf-5ff0cb000001",
                                    "sensor": "temp", "min": 18, "max": 30, "delay_minutes": 5,
                                    "enabled": True})
        if self.settings.simulate_vivosun and self.settings.simulate_spiderfarmer:
            outputs = [
                {"device_id": "sf-5ff0cb000001", "control_id": "light", "role": "light"},
                {"device_id": "vs-900000000000000102", "control_id": "hmdf", "role": "humidifier"},
                {"device_id": "vs-900000000000000104", "control_id": "dhmdf", "role": "dehumidifier"},
                {"device_id": "sf-5ff0cb000001", "control_id": "heater", "role": "heater"},
            ]
            if self.settings.simulate_acinfinity:
                outputs += [
                    {"device_id": "aci-3101000000000000002", "control_id": "p1", "role": "exhaust",
                     "min_level": 2, "max_level": 8},
                    {"device_id": "aci-3101000000000000002", "control_id": "p2", "role": "circulation",
                     "day_level": 6, "night_level": 3},
                ]
            try:
                await self.room_control.save("zelt-1", {
                    "enabled": True, "sensor_mode": "average", "day_source": "light", "humidity_mode": "vpd",
                    "temp": {"day": 24.5, "night": 21, "tolerance": 1},
                    "humi": {"day": 60, "night": 55, "tolerance": 4},
                    "vpd": {"day": 1.15, "night": 0.9, "tolerance": 0.1},
                    "co2": {"enabled": False, "day": 900, "tolerance": 100},
                    "outputs": outputs,
                })
            except ValueError as err:
                _LOGGER.warning("Demo-Zeltsteuerung nicht angelegt: %s", err)
        await self._seed_demo_growplan()
        await self._seed_demo_extras()
        await self.db.set_setting("demo_seeded", True)

    async def _seed_demo_extras(self) -> None:
        """Growplan alarm, watering reminders, a camera with photos and one finished grow."""
        plan = self.growplan.for_room("zelt-1")
        if plan is None:
            return
        await self.alarms.save({"kind": "growplan", "room_id": "zelt-1", "metrics": ["temp", "humi", "vpd"],
                                "delay_minutes": 30, "enabled": True})
        await self.watering.save_settings(plan["id"], {"days": 3, "time": "09:00", "soil_below": 30, "detect": True})
        try:
            camera = await self.cameras.create({"name": "Zelt 1 Kamera", "source": "demo", "room_id": "zelt-1",
                                                "times": ["12:00"], "only_light": True})
        except CameraError as err:
            _LOGGER.warning("Demo-Kamera nicht angelegt: %s", err)
            return
        today = self.growplan.today()
        noon = time.mktime((today - timedelta(days=1)).timetuple()) + 12 * 3600

        async def photos() -> None:
            for back in range(20, -1, -1):
                try:
                    await self.cameras.snapshot(camera["id"], source="auto", now=noon - back * 86400)
                except CameraError:
                    return
                await asyncio.sleep(0.05)

        asyncio.get_running_loop().create_task(photos())
        started = today - timedelta(days=170)
        flower = started + timedelta(days=45)
        harvested = flower + timedelta(days=63)
        await self.db.save_grow({
            "id": "grow-demo1", "room_id": "zelt-1", "room_name": "Zelt 1", "plan_name": "Zelt 1",
            "name": "Frühjahr: Northern Lights", "strain": "Northern Lights, Amnesia Haze",
            "started": started.isoformat(), "harvested": harvested.isoformat(), "flower_start": flower.isoformat(),
            "yield_g": 412.0, "rating": 4, "notes": "Gleichmäßige Blüten, Amnesia etwas luftig. Nächstes Mal früher entlauben.",
            "plants": plan["data"]["plants"][:2], "medium": "erde", "lamp": plan["data"]["lamp"], "sched": "bb-light",
            "stats": {"days": (harvested - started).days, "veg_days": 45, "flower_days": 63, "waterings": 41, "feeds": 27,
                      "liters": 236.5, "notes": 6, "ec_in": 1.34, "ph_in": 6.38, "ec_out": 1.92, "ph_out": 6.45,
                      "lamp_watts": 300, "kwh": 469.8, "cost": 140.94, "price": 0.3, "climate_days": 0,
                      "climate": {"veg": {"temp_day": 25.1, "temp_night": 21.2, "humi_day": 61.5, "vpd_day": 1.08,
                                          "in_temp": 0.86, "in_humi": 0.71, "in_vpd": 0.64, "light_hours": 18.0,
                                          "dli": 31.5, "days": 45},
                                  "flower": {"temp_day": 24.4, "temp_night": 19.6, "humi_day": 51.2, "vpd_day": 1.36,
                                             "in_temp": 0.91, "in_humi": 0.62, "in_vpd": 0.58, "light_hours": 12.0,
                                             "dli": 33.1, "days": 63}},
                      "photos": 0},
            "plan": plan["data"], "log": [], "created": int(time.time()) - 60 * 86400,
            "updated": int(time.time()) - 60 * 86400,
        })

    async def _seed_demo_growplan(self) -> None:
        """Zelt 1 in flowering week 3 with a few waterings, so the Growplan page is not empty."""
        today = self.growplan.today()
        flower = today - timedelta(days=16)
        veg = flower - timedelta(days=35)
        try:
            plan = await self.growplan.create("zelt-1", "Zelt 1", {
                "vegStart": veg.isoformat(), "floStart": flower.isoformat(), "vegWeeks": 5, "floWeeks": 9,
                "sched": "bb-light", "liters": 6, "tent": 1.2, "medium": "erde", "phase": "flower", "week": 3,
                "plants": [
                    {"id": "p1", "name": "Links", "strain": "Northern Lights", "pot": 18, "start": (veg - timedelta(days=12)).isoformat()},
                    {"id": "p2", "name": "Mitte", "strain": "Amnesia Haze", "pot": 18, "start": (veg - timedelta(days=12)).isoformat()},
                    {"id": "p3", "name": "Rechts", "strain": "Blueberry", "type": "auto", "pot": 11, "start": (veg - timedelta(days=5)).isoformat()},
                ],
            })
        except GrowPlanError as err:
            _LOGGER.warning("Demo-Growplan nicht angelegt: %s", err)
            return
        # BioBizz Light-Mix, doses per litre in the veg column 2 and the bloom weeks 1-9
        doses = [("Bio-Grow", "#7CB342", 2, [2, 2, 3, 3, 4, 4, 4, 4, 0]), ("Bio-Bloom", "#C62828", 0, [1, 2, 2, 3, 3, 4, 4, 4, 0]),
                 ("Top-Max", "#D81B60", 0, [1, 1, 1, 1, 1, 4, 4, 4, 0]), ("Bio-Heaven", "#EF6C00", 2, [2, 2, 3, 4, 4, 5, 5, 5, 0]),
                 ("Alg-A-Mic", "#F9A825", 0, [1, 2, 2, 3, 3, 4, 4, 4, 0]), ("Acti-Vera", "#1565C0", 2, [2, 2, 3, 4, 4, 5, 5, 5, 0])]
        waterings = [(-22, "feed", 5, 1.2, 6.4, None, None), (-19, "water", 5, None, 6.5, None, None),
                     (-16, "feed", 6, 1.3, 6.3, 1.9, 6.4), (-13, "water", 6, None, 6.4, None, None),
                     (-10, "feed", 6, 1.4, 6.4, 2.0, 6.5), (-7, "water", 6, 0.4, 6.5, None, None),
                     (-4, "feed", 6, 1.5, 6.3, 2.1, 6.4), (-1, "feed", 6, 1.5, 6.4, None, None)]
        entries = []
        for offset, kind, liters, ec, ph, ec_out, ph_out in waterings:
            day = today + timedelta(days=offset)
            if day >= flower:
                phase, week = "flower", (day - flower).days // 7 + 1
                mix = [{"n": n, "u": "ml", "v": b[week - 1], "c": c} for n, c, _v, b in doses if b[week - 1]]
            else:
                phase, week = "veg", min(5, (day - veg).days // 7 + 1)
                mix = [{"n": n, "u": "ml", "v": v, "c": c} for n, c, v, _b in doses if v]
            entries.append({"id": f"demo{offset + 30:02d}", "ts": int(time.time() * 1000) + offset, "date": day.isoformat(),
                            "type": kind, "liters": liters, "strength": 100, "phase": phase, "week": week,
                            "sched": {"id": "bb-light", "name": "BioBizz · Light-Mix / Coco-Mix"},
                            "ecIn": ec, "phIn": ph, "ecOut": ec_out, "phOut": ph_out, "plants": [],
                            "mix": mix if kind == "feed" else []})
        entries.append({"id": "demo-note", "ts": int(time.time() * 1000), "date": (today - timedelta(days=9)).isoformat(),
                        "type": "note", "phase": "flower", "week": 2, "plants": ["p1", "p2"], "tags": ["Entlaubt", "LST / Training"],
                        "note": "Untere Triebe entfernt, Blüten bilden sich gleichmäßig."})
        for entry in entries:
            try:
                await self.growplan.save_entry(plan["id"], entry)
            except GrowPlanError as err:
                _LOGGER.warning("Demo-Gießung nicht angelegt: %s", err)
