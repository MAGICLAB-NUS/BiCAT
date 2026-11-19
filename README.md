# BiCAT project website

Source of the BiCAT project page. This is a plain static site (no build step), published from the
`website` branch of https://github.com/MAGICLAB-NUS/BiCAT with GitHub Pages.

## Structure

| Path | What it is |
|---|---|
| `index.html` | The whole page. |
| `static/css/index.css` | All styles. Paper colours: teal `#1F6676` = left arm, orange `#C96A2B` = right arm. |
| `static/js/main.js` | Page behaviour: teaser player with scrubbable progress bar, cartoon kittens, real-world comparison player, charts, step cards. All numbers are copied from the paper's tables. |
| `static/js/mirror-demo.js` | 3D mirror-canonicalization demo on Bimanual YAM (loads only when step 1 of the Method is opened). |
| `static/js/vendor/` | three.js r160 and OrbitControls (MIT, see `LICENSE-three.js.txt`). |
| `static/models/yam/` | Compact YAM model for the demo, derived from MuJoCo Menagerie `i2rt_yam` (MIT, see `LICENSE` and `README.md`). |
| `static/videos/bicat_teaser.mp4` | Teaser film at the top of the page (+ `bicat_teaser.jpg` poster). |
| `static/videos/rollouts/` | Real-world rollouts, `<robot>_<task>_<method>.mp4`, method ∈ {bicat, oat, fast}; H.264 720p, no audio. Posters in `static/videos/posters/`. |
| `static/images/` | Figures (teaser as vector SVG from `teaser.pdf`, method, RoboTwin tasks, analysis), MAGIC Lab logo, favicon. `teaser.png` is only the social-preview image. |
| `static/paper-assets/` | The three figure PDFs linked from captions. |
| `BiCAT.pdf` | Local copy of the paper, served at `/BiCAT/BiCAT.pdf`. The "Paper" button links to arXiv: https://arxiv.org/abs/2611.23499. |

`source-materials/` (manuscript LaTeX, earlier versions of the page) is kept locally only and is listed in `.gitignore`.

## Local preview

```sh
cd '/Users/xuanwei/MAGIC Lab/BiCAT/BiCAT_website'
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765/ (use a server: ES modules and videos do not work from `file://`).
`python -m http.server` cannot serve byte ranges; the teaser player falls back to loading the
video once so seeking still works. GitHub Pages supports ranges natively.

## Publishing

GitHub Pages redeploys automatically on every push **if** the repository is set to
*Settings → Pages → Build and deployment → Source: Deploy from a branch → `website` / `(root)`*.
The site is then served at https://magiclab-nus.github.io/BiCAT/. `.nojekyll` makes Pages serve the
files as-is.

```sh
git push magiclab gh-pages:website
```
