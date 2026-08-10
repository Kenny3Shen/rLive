package com.shenss.rlive

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeTabRouteTest {
  @Test
  fun keepsSettingsOverviewAsAHomeTabRoot() {
    assertTrue(isHomeTabRoute("/settings", null))
    assertTrue(isHomeTabRoute("/settings", ""))
  }

  @Test
  fun treatsSettingsSectionsAsDrilledDownRoutes() {
    assertFalse(isHomeTabRoute("/settings", "playback"))
    assertFalse(isHomeTabRoute("/settings", "account"))
  }

  @Test
  fun preservesOtherRootAndDrilledDownRoutes() {
    assertTrue(isHomeTabRoute("/", null))
    assertTrue(isHomeTabRoute("/follow", null))
    assertFalse(isHomeTabRoute("/room/bilibili/1", null))
    assertFalse(isHomeTabRoute("/category/1/2", null))
  }
}
