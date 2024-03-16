# metromap
Algorithm to layout and draw a network in the style typical of urban transit metro maps.

## Install

Using pip:

```shell
pip install NAME_OF_PROJECT
```

Run tests:

```
# first create a virtual environment
source .venv/bin/activate
make lint
make test
```

## Example

```python
TODO
```

## Publish new version

> For developers

You can publish the project to PyPI in two ways:

1. Create release on Github, which automatically triggers publication to PyPI via Github Actions.
2. Build locally and push to PyPI

### Method 1: Via Github Actions

- On Github, set secrets.PYPI_API_TOKEN
- Update version number in pyproject.toml
- Merge to main (via PR, direct push to main or other way)
- Create new release on Github

### Method 2: Direct to PyPI

Build and upload:

```shell
python -m build
twine upload dist/*
```
