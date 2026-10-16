# RigCheck

RigCheck is a small browser utility for generating a local PC hardware report and opening the relevant live PriceSquirrel price category.

## Why the browser boundary matters

Modern browsers do not expose arbitrary PCI/SMBIOS hardware to a web page. This prototype keeps the permission boundary explicit:

- the browser scan reads safe hints such as platform and logical-core count;
- WebHID/WebUSB device lists are queried only after a user click and only include previously authorized devices;
- a trusted local text/JSON/CSV report can be parsed in-browser as a fallback;
- no report is uploaded by this static page.

The page provides read-only scripts for Windows PowerShell, macOS Terminal and Linux Terminal. Each script prints CPU, GPU, RAM, storage, motherboard and OS information in a paste-ready format and copies the output to the local clipboard. Pasting updates the component list automatically; tracked component types show a direct PriceSquirrel category link. The page does not upload the report.

## Run locally

Open `index.html` directly, or serve the folder with any static server. No package install is needed.

## GitHub Pages

The included workflow publishes the repository root to GitHub Pages whenever `main` changes. It can also be started manually from the Actions tab.
