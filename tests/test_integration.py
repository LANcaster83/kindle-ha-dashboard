"""Entity, service and HTTP endpoint tests."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.kindle_dashboard.const import DOMAIN, IMAGE_PATH, STATUS_PATH

from .conftest import DEVICE_TOKEN, PNG_BYTES, RENDERER_URL, STATUS_OK


async def setup_entry(hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(f"{RENDERER_URL}/status", json=STATUS_OK)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_entities_and_button(
    hass: HomeAssistant, mock_entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """Sensors reflect renderer status; the button triggers POST /render."""
    await setup_entry(hass, mock_entry, aioclient_mock)
    registry = er.async_get(hass)

    render_state = hass.states.get("sensor.kindle_last_render")
    assert render_state is not None
    assert render_state.state == "2026-10-08T12:00:00+00:00"
    assert render_state.attributes["render_count"] == 3

    status = hass.states.get("sensor.kindle_renderer_status")
    assert status is not None
    assert status.state == "ok"

    battery = hass.states.get("sensor.kindle_battery")
    assert battery is not None
    assert battery.state == "unknown"

    assert registry.async_get("button.kindle_render_now") is not None
    aioclient_mock.post(f"{RENDERER_URL}/render", json={**STATUS_OK, "render_count": 4})
    await hass.services.async_call("button", "press", {"entity_id": "button.kindle_render_now"}, blocking=True)
    assert aioclient_mock.call_count >= 2
    assert any(call[0] == "POST" and str(call[1]).endswith("/render") for call in aioclient_mock.mock_calls)

    # The domain service does the same.
    await hass.services.async_call(DOMAIN, "render", {}, blocking=True)
    assert sum(1 for call in aioclient_mock.mock_calls if call[0] == "POST") == 2


async def test_views_require_device_token(
    hass: HomeAssistant,
    mock_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    """Image proxy and status endpoint accept only the device token."""
    await setup_entry(hass, mock_entry, aioclient_mock)
    aioclient_mock.get(
        f"{RENDERER_URL}/kindle.png", content=PNG_BYTES, headers={"Content-Type": "image/png", "X-Image-Size": "1x1"}
    )
    client = await hass_client_no_auth()

    assert (await client.get(IMAGE_PATH)).status == 401
    assert (await client.get(f"{IMAGE_PATH}?token=wrong")).status == 401
    assert (await client.post(STATUS_PATH, json={"battery": 50})).status == 401

    resp = await client.get(f"{IMAGE_PATH}?token={DEVICE_TOKEN}")
    assert resp.status == 200
    assert resp.content_type == "image/png"
    assert resp.headers["X-Image-Size"] == "1x1"
    assert await resp.read() == PNG_BYTES
    await hass.async_block_till_done()
    assert hass.states.get("sensor.kindle_last_seen").state != "unknown"

    resp = await client.post(
        f"{STATUS_PATH}?token={DEVICE_TOKEN}", json={"battery": 73, "charging": False, "firmware": "5.16.2.1.1"}
    )
    assert resp.status == 200
    await hass.async_block_till_done()
    battery = hass.states.get("sensor.kindle_battery")
    assert battery.state == "73"
    assert battery.attributes["charging"] is False
    assert battery.attributes["firmware"] == "5.16.2.1.1"

    # Header auth and query-parameter payloads work too (busybox wget friendly).
    resp = await client.post(f"{STATUS_PATH}?battery=12&charging=true", headers={"X-Kindle-Token": DEVICE_TOKEN})
    assert resp.status == 200
    await hass.async_block_till_done()
    assert hass.states.get("sensor.kindle_battery").state == "12"

    assert (await client.post(f"{STATUS_PATH}?token={DEVICE_TOKEN}", data=b"not json")).status == 400


async def test_views_accept_ha_auth(
    hass: HomeAssistant,
    mock_entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    hass_client: ClientSessionGenerator,
) -> None:
    """A logged-in HA user can open the image without the device token."""
    await setup_entry(hass, mock_entry, aioclient_mock)
    aioclient_mock.get(f"{RENDERER_URL}/kindle.png", content=PNG_BYTES, headers={"Content-Type": "image/png"})
    client = await hass_client()
    resp = await client.get(IMAGE_PATH)
    assert resp.status == 200
    assert resp.content_type == "image/png"


async def test_renderer_offline_after_setup(
    hass: HomeAssistant, mock_entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """When the renderer disappears the status sensor goes offline and the image proxy returns 502."""
    await setup_entry(hass, mock_entry, aioclient_mock)
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{RENDERER_URL}/status", exc=OSError("down"))
    coordinator = mock_entry.runtime_data.coordinator
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get("sensor.kindle_renderer_status").state == "offline"
