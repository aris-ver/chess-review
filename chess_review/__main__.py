"""python -m chess_review <stage> [args]   (each stage is also runnable as python -m chess_review.<stage>)"""

import logging
import sys

from . import aggregates, analyse, classify, export, ingest, normalise, serve, site


def review(argv):
    """classify -> site -> aggregates, in one go."""
    classify.main(argv)
    site.main(argv)
    aggregates.main(argv)


STAGES = {
    "ingest": ingest.main, "normalise": normalise.main, "analyse": analyse.main, "export": export.main,
    "classify": classify.main, "site": site.main, "aggregates": aggregates.main, "review": review, "serve": serve.main,
}

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if len(sys.argv) < 2 or sys.argv[1] not in STAGES:
        sys.exit(f"usage: python -m chess_review {{{'|'.join(STAGES)}}} [args]")
    STAGES[sys.argv[1]](sys.argv[2:])
