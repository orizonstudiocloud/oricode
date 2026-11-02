# Copyright (c) Microsoft Corporation. Licensed under the MIT License.
"""Authenticate IDE sessions independently of model and billing access."""

import asyncio

from fastapi import Depends, HTTPException, Request


def register_ide_auth_routes(app, auth_db, team_db, sync_auth):
    provisioning_lock = asyncio.Lock()

    async def current_user(request: Request):
        user = await sync_auth(request)
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="Inicia sesión en OriCode.")
        return user

    def public_user(user):
        return {"id": user.id, "username": user.username, "role": user.role}

    @app.get("/api/auth/ide/me")
    async def ide_me(user=Depends(current_user)):
        return {"authenticated": True, "user": public_user(user)}

    @app.post("/api/auth/ide/connect")
    async def ide_connect(user=Depends(current_user)):
        async with provisioning_lock:
            organizations = team_db.list_orgs_for_user(user.id)
            if not organizations:
                # Legacy accounts receive only their own free space, with zero paid credits.
                organizations = [team_db.create_org(f"{user.username} Personal", owner_id=user.id, plan="local")]
            if not any(org.get("is_active") for org in organizations):
                raise HTTPException(status_code=403, detail="Tu organización está desactivada. Contacta con soporte.")
        return {"authenticated": True, "user": public_user(user), "ai_api_key": auth_db.get_user_api_key(user.id)}
