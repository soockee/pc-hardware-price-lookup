# RigCheck

RigCheck is a browser-safe, static prototype for identifying a user's PC hardware and handing off to live European pricing on [PriceSquirrel](https://www.pricesquirrel.com/).

## Why the browser boundary matters

Modern browsers do not expose arbitrary PCI/SMBIOS hardware to a web page. This prototype keeps the permission boundary explicit:

- the browser scan reads safe hints such as platform and logical-core count;
- WebHID/WebUSB device lists are queried only after a user click and only include previously authorized devices;
- a trusted local text/JSON/CSV report can be parsed in-browser as a fallback;
- no report is uploaded by this static page.

The current price cards are labeled as a preview and link to PriceSquirrel search pages. A production version should connect a permitted server-side adapter or a documented PriceSquirrel data endpoint, then replace the preview label with returned prices and timestamps.

## Run locally

Open `index.html` directly, or serve the folder with any static server. No package install is needed.

## GitHub Pages

The included workflow publishes the repository root to GitHub Pages whenever `main` changes. It can also be started manually from the Actions tab.
