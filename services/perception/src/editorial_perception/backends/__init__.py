"""Model backends.

Each one is optional and says so. A backend whose package is not installed
raises MissingDependency, which the compiler reads as "this stage is
unavailable" and works around, rather than as a failure.
"""
