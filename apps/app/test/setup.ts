import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

/**
 * Testing Library auto-registers its cleanup only when the test framework's
 * globals are enabled. They are not — explicit imports make it obvious where a
 * symbol came from — so cleanup is registered here instead.
 *
 * Without it, `render` appends to the same `document.body` every time and the
 * second test in a file sees the first test's DOM. The symptom is a confusing
 * "found multiple elements" on a component that renders one.
 */
afterEach(cleanup)
