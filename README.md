# wrtTIME
wrtTIME - An easy web interface for OpenWrt configuration.
> [!WARNING]
> ### 100% AI-Generated Project 
>
> **wrtTIME was created with AI.** Compatibility issues may occur, so please verify that your router is supported before installation.

- Supports OpenWrt 25+
- Korean only

## Demo
**[Try the live demo](https://nyamumu.github.io/wrttime/)** (login: `root` / `admin`)

The demo runs entirely in your browser with simulated router data. Changes are not saved and reset when the page is reloaded.

## Screenshot
![wrtTIME system summary page](docs/images/home.webp)

## Install
Connect to your router over SSH and run:

```sh
uclient-fetch -qO- https://raw.githubusercontent.com/Nyamumu/wrttime/release/install.sh | sh
```

Then open your router's address in a browser and log in with the router's `root` account. Running the same command again updates wrtTIME to the latest version.

## Tested
- GL.iNet GL-MT3000 OpenWrt 25.12.6
- GL.iNet GL-MT6000 OpenWrt 25.12.6
- ipTIME AX3000Q OpenWrt 25.12.5 ~ 6
