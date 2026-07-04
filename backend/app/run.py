import os

import uvicorn

from app.core.config import get_settings
from app.main import app


def main() -> None:
    if os.environ.get("NEXUS_FLOW_API_IMPORT_CHECK") == "1":
        from DrissionPage import ChromiumOptions, ChromiumPage

        print(
            "import check ok:",
            ChromiumOptions.__name__,
            ChromiumPage.__name__,
        )
        return

    settings = get_settings()
    uvicorn.run(
        "app.main:app" if settings.api_reload else app,
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.api_reload,
        reload_dirs=["app"] if settings.api_reload else None,
    )


if __name__ == "__main__":
    main()
