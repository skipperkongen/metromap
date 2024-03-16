install:
	pip install -e '.[tests]'

lint:
	source venv/bin/activate && flake8 --max-line-length 100 src
.PHONY: lint

test:
	pytest
.PHONY: test

build:
	python -m build
.PHONY: test

publish: build
	twine upload dist/*
.PHONY: build

clean:
	rm -rf dist
.PHONY: clean