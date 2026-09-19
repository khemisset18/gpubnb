"""Workspace gateway regression suite entrypoint.

The large historical suite lives in workspace_gateway_suite_impl.py unchanged so
older coverage remains intact.  PR #219/v9 intentionally made Cloud Desktop,
Creator, CAD and Gaming executable gateway slugs, so this wrapper replaces only
the obsolete pre-v9 assertion that reconciliation must fall back to Developer.
"""
from workspace_gateway_suite_impl import *  # noqa: F401,F403
from workspace_gateway_suite_impl import (
    DesktopWorkspaceFamilyLaunchTests as _DesktopWorkspaceFamilyLaunchTestsBase,
    _future,
)


class DesktopWorkspaceFamilyLaunchTests(_DesktopWorkspaceFamilyLaunchTestsBase):
    """v9 routing contract for the four graphical desktop Workspace slugs.

    These tests prove Agent routing only. They do not prove physical Linux desktop
    rendering or Windows-native qualification/bookability.
    """

    # Supersede the inherited pre-v9 test name/behavior. unittest ignores this
    # non-callable attribute and discovers the v9-specific test below instead.
    test_reconcile_does_not_yet_launch_any_desktop_workspace_slug = None

    def test_reconcile_routes_each_desktop_workspace_slug_to_its_own_image(self) -> None:
        for slug, image in (
            ("cloud-desktop", CLOUD_DESKTOP_IMAGE),
            ("creator", CREATOR_IMAGE),
            ("cad", CAD_IMAGE),
            ("gaming", GAMING_IMAGE),
        ):
            with self.subTest(slug=slug):
                docker, api = FakeDocker(), FakeApi()
                api.sessions = [{
                    "id": f"sess-{slug}-2",
                    "status": "READY",
                    "expiresAt": _future(),
                    "connectionMetadata": {},
                    "workspaceSlug": slug,
                }]
                supervisor = self._supervisor(docker, api)

                supervisor._reconcile_sessions()

                workspace = names_for_session(f"sess-{slug}-2")[0]
                run = next(
                    call for call in docker.calls
                    if call[0] == "run" and call[call.index("--name") + 1] == workspace
                )
                self.assertIn(image, run)
                self.assertNotIn(OFFICIAL_IMAGE, run)


del _DesktopWorkspaceFamilyLaunchTestsBase
