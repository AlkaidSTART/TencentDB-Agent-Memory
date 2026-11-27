import httpx
import pytest

from tencentdb_agent_memory._http import (
    AsyncHttpStub as V2AsyncHttpStub,
    HttpStub as V2HttpStub,
)
from tencentdb_agent_memory._v3_http import (
    AsyncHttpStub as V3AsyncHttpStub,
    HttpStub as V3HttpStub,
)
from tencentdb_agent_memory.errors import ParamError, TDAMError


def test_v2_sync_handles_null_data_with_trace_id_and_preserves_injected_client():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://memory.example.com/v2/delete")
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": None},
            headers={"x-trace-id": "trace-123"},
        )

    shared_client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        stub = V2HttpStub(
            endpoint="https://memory.example.com/",
            api_key="sk-test",
            service_id="mem-1",
            client=shared_client,
        )
        result = stub.post("v2/delete", {"id": "1"})
        assert result == {"trace_id": "trace-123"}

        # Closing stub must NOT close caller-owned shared client
        stub.close()
        assert shared_client.is_closed is False
    finally:
        shared_client.close()


@pytest.mark.asyncio
async def test_v2_async_handles_null_data_and_preserves_injected_client():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": None},
            headers={"x-trace-id": "trace-async"},
        )

    shared_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        stub = V2AsyncHttpStub(
            endpoint="https://memory.example.com",
            api_key="sk-test",
            service_id="mem-1",
            client=shared_client,
        )
        result = await stub.post("/v2/delete", {})
        assert result == {"trace_id": "trace-async"}

        await stub.close()
        assert shared_client.is_closed is False
    finally:
        await shared_client.aclose()


def test_v3_sync_rejects_bool_or_missing_code_with_minus_one_and_validates_timeout():
    responses = iter(
        [
            httpx.Response(200, json={"code": True, "message": "bool code"}),
            httpx.Response(200, json={"message": "missing code"}),
        ]
    )
    shared_client = httpx.Client(
        transport=httpx.MockTransport(lambda _req: next(responses))
    )
    try:
        stub = V3HttpStub(
            endpoint="https://memory.example.com/",
            api_key="sk-test",
            service_id="mem-1",
            client=shared_client,
        )

        with pytest.raises(TDAMError) as exc1:
            stub.post("/v3/test", {})
        assert exc1.value.code == -1

        with pytest.raises(TDAMError) as exc2:
            stub.post("/v3/test", {})
        assert exc2.value.code == -1

        with pytest.raises(ParamError, match="timeout must be a positive number"):
            stub.post("/v3/test", {}, timeout=0)

        with pytest.raises(ParamError, match="timeout must be a positive number"):
            stub.get("/v3/test", timeout=-5)

        stub.close()
        assert shared_client.is_closed is False
    finally:
        shared_client.close()


@pytest.mark.asyncio
async def test_v3_async_closes_owned_client_but_preserves_injected_client():
    owned_stub = V3AsyncHttpStub(
        endpoint="https://memory.example.com",
        api_key="sk-test",
        service_id="mem-1",
    )
    await owned_stub.close()
    assert owned_stub.client.is_closed is True

    shared_client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200,
                json={"code": 0, "data": {"url": str(req.url)}},
            )
        )
    )
    try:
        injected_stub = V3AsyncHttpStub(
            endpoint="https://memory.example.com/",
            api_key="sk-test",
            service_id="mem-1",
            client=shared_client,
        )
        res = await injected_stub.get("v3/items", query={"a": "1"})
        assert res["url"] == "https://memory.example.com/v3/items?a=1"

        await injected_stub.close()
        assert shared_client.is_closed is False
    finally:
        await shared_client.aclose()
