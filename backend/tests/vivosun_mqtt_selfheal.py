# Self-healing test of the Vivosun AWS IoT session against a local mosquitto with a websocket listener
# (listener 9001 + protocol websockets, TCP listener 18883). Run from backend/: python tests/vivosun_mqtt_selfheal.py
import asyncio, logging, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
from app.adapters.vivosun import cloud as cloud_mod
from app.adapters.vivosun.vendor import mqtt_client as mqtt_mod
from app.adapters.vivosun.adapter import VivosunAdapter
from app.adapters.vivosun.vendor.models import AuthTokens, AwsIdentity, DeviceInfo
mqtt_mod.ssl.create_default_context = lambda *a, **k: None
DEVICES = [
    DeviceInfo(device_id="1001", client_id="vivosun-VSCTLE42A-AABBCC", topic_prefix="vs/AABBCC", name="GrowHub E42A", online=True, scene_id=1, device_type="controller"),
    DeviceInfo(device_id="1002", client_id="vivosun-VSHMDH19-DDEEFF", topic_prefix="vs/DDEEFF", name="AeroStream H19", online=True, scene_id=1, device_type="humidifier"),
]
class FakeApi:
    def __init__(self, session): pass
    async def login(self, email, password): return AuthTokens(access_token="a", login_token="l", refresh_token="r", user_id="u")
    async def get_devices(self, tokens): return DEVICES
    async def get_aws_identity(self, tokens): return AwsIdentity(aws_host="localhost", aws_region="eu-central-1", aws_identity_id="id", aws_open_id_token="t", aws_port=443)
    async def get_point_log_raw(self, tokens, info, start_time, end_time): return {"inTemp": 2450, "inHumi": 6000, "inVpd": 120}
class FakeAws:
    def __init__(self, session): pass
    async def get_credentials_for_identity(self, identity): return object()
    def credentials_need_refresh(self, creds): return False
    def sigv4_sign_mqtt_url(self, endpoint, region, credentials): return "ws://localhost:9001/mqtt"
cloud_mod.VivosunApiClient = FakeApi
cloud_mod.AwsAuthClient = FakeAws

class Hub:
    devices = {}
    def update_device(self, device): self.devices[device.id] = device
    def remove_device(self, device_id): self.devices.pop(device_id, None)

cloud_mod.VivosunApiClient = FakeApi
cloud_mod.AwsAuthClient = FakeAws

# emulate AWS IoT: publishing to a forbidden topic ends the connection
FORBIDDEN = "$aws/things/vivosun-VSHMDH19-DDEEFF/shadow/get"
original_publish = mqtt_mod.MQTTClient.publish
async def aws_like_publish(self, topic, payload, qos=0, retain=False):
    await original_publish(self, topic, payload, qos, retain)
    if topic == FORBIDDEN:
        await self._ws.close()
mqtt_mod.MQTTClient.publish = aws_like_publish

def show(cloud, label):
    print(f"{label}: state={cloud.state} mqtt={cloud.mqtt_state} error={cloud.last_error}", flush=True)

async def wait_for(cond, seconds):
    end = time.time() + seconds
    while time.time() < end and not cond():
        await asyncio.sleep(0.5)
    return cond()

async def main():
    cloud = cloud_mod.VivosunCloud("x@example.com", "pw", poll_interval=30)
    cloud._poll_interval = 4
    adapter = VivosunAdapter(cloud)
    hub = Hub()
    await adapter.start(hub)
    await asyncio.sleep(2.5)
    show(cloud, "1 first attempt (forbidden shadow get)")
    ok = await wait_for(lambda: cloud.mqtt_state == "connected", 20)
    show(cloud, f"2 self-healed={ok}")
    print("   blocked:", cloud._shadow_get_blocked, "devices online:", {d.name: d.online for d in hub.devices.values()})
    subprocess.run(["pkill", "-f", "^mosquitto -c /tmp/vsh/mosq-ws.conf"])
    await asyncio.sleep(5)
    show(cloud, "3 broker down")
    print("   devices online during outage:", {d.name: d.online for d in hub.devices.values()})
    try:
        await cloud.publish_desired("1001", {"light": {"lv": 50}})
    except ConnectionError as err:
        print("   command during outage ->", err)
    subprocess.Popen(["mosquitto", "-c", "/tmp/vsh/mosq-ws.conf", "-d"], start_new_session=True)
    ok = await wait_for(lambda: cloud.mqtt_state == "connected", 40)
    show(cloud, f"4 broker back, reconnected={ok}")
    await cloud.publish_desired("1001", {"light": {"lv": 50}})
    print("   command after reconnect: ok")
    await adapter.stop()

asyncio.run(main())
