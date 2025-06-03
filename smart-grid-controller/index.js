/**
 * Signal K Smart Grid Controller Plugin
 * 
 * PURPOSE:
 * Intelligently controls when grid AC power is allowed to flow to your Victron MultiPlus II.
 * This plugin acts as an automated grid management system that decides when to connect/disconnect
 * grid power based on battery state, power demand, time scheduling, and multiple safety protections.
 * 
 * HOW IT WORKS:
 * The plugin monitors your battery voltage, AC load, and time, then controls a relay (virtual switch)
 * that enables/disables grid AC input to your MultiPlus. It reads data from your Victron system
 * via Signal K and sends control commands back through the Cerbo GX.
 * 
 * FOUR ENABLE CONDITIONS (Grid turns ON if ANY condition is met):
 * 
 * 1. HIGH LOAD CONDITION
 *    - Enables when: AC load > 2500W for 3+ seconds 
 *    - Disables when: AC load drops below 1750W
 *    - Purpose: Allows grid to help with high power demands (heat pumps, electric vehicles, etc.)
 *    - Hysteresis gap: 750W (2500W↔1750W) prevents rapid switching
 * 
 * 2. LOW VOLTAGE CONDITION  
 *    - Enables when: DC voltage < 50.83V for 3+ seconds
 *    - Disables when: DC voltage rises above 53.1V
 *    - Purpose: Prevents battery from going too low (around 10% SoC)
 *    - Hysteresis gap: 2.27V prevents rapid switching
 * 
 * 3. LOW STATE OF CHARGE CONDITION
 *    - Enables when: Battery SoC < 10% for 3+ seconds  
 *    - Disables when: Battery SoC rises above 30%
 *    - Purpose: Backup protection based on calculated state of charge
 *    - Hysteresis gap: 20% prevents rapid switching
 * 
 * 4. SCHEDULED CHARGING WINDOW
 *    - Enables when: UK time between 00:00 and 06:00
 *    - Disables when: Outside this time window
 *    - Purpose: Allows cheap overnight charging during off-peak electricity rates
 *    - No delay: Immediate enable/disable at time boundaries
 * 
 * BATTERY PROTECTION LAYERS:
 * 
 * STANDARD PROTECTION (Can be overridden by high loads):
 *    - Triggers when: Voltage > 61.5V OR SoC > 95%
 *    - Clears when: Voltage < 60.0V AND SoC < 90%  
 *    - Override: High load condition (>2500W) can keep grid on
 *    - Purpose: Prevents routine overcharging while allowing critical loads
 * 
 * EMERGENCY PROTECTION (Cannot be overridden):
 *    - Triggers when: Voltage > 63.0V
 *    - Clears when: Voltage < 62.0V
 *    - Override: NONE - immediately disconnects grid regardless of load
 *    - Purpose: Final safety protection against battery damage
 * 
 * TIMING BEHAVIOR:
 * 
 * Enable Delays (prevents false triggers):
 *    - Load, voltage, SoC conditions: 3 seconds
 *    - Time condition: Immediate
 *    - Purpose: Avoids reacting to momentary spikes/dips in readings
 * 
 * Disable Delays:
 *    - Normal conditions: 30 seconds after ALL conditions clear
 *    - Battery protection: Immediate when triggered  
 *    - Emergency protection: Immediate when triggered
 *    - Purpose: Provides stability, prevents rapid cycling
 * 
 * Startup Behavior:
 *    - Grid enabled immediately on plugin start
 *    - 30-second grace period before normal evaluation begins
 *    - Purpose: Ensures reliable operation during system restarts
 * 
 * HYSTERESIS EXPLANATION:
 * Hysteresis means different thresholds for turning ON vs turning OFF.
 * Example: Load enables at 2500W but disables at 1750W.
 * This prevents rapid on/off cycling when readings hover near a single threshold.
 * 
 * BATTERY CONFIGURATION:
 * Currently configured for Li-NCM 15S and LiFePO4 16S battery packs.
 * - Li-NCM 15S: Voltage-to-SoC mapping based on real discharge curve data
 * - LiFePO4 16S: Based on real LiFePO4 cell characteristics (3.1V-3.4V per cell operating range)
 *   Uses the incredibly flat LiFePO4 discharge curve for accurate SoC estimation
 * 
 * HARDWARE CONNECTIONS:
 * - Reads from: electrical.chargers.275.voltage (DC voltage)
 * - Reads from: electrical.inverters.275.acout.power (AC load)  
 * - Controls: electrical.switches.relay1.state (grid AC enable/disable)
 * - Maps to: com.victronenergy.system /Relay/1/State (Cerbo GX Relay 1)
 */

module.exports = function smartGridController(app) {
    // Logging helper with consistent formatting
    function log(level, message, data = {}) {
      const timestamp = new Date().toISOString();
      const prefix = 'Smart Grid Controller';
      if (Object.keys(data).length > 0) {
        console[level](`[${timestamp}] ${prefix}: ${message}`, data);
      } else {
        console[level](`[${timestamp}] ${prefix}: ${message}`);
      }
    }

    // Start with grid enabled on startup
    let relayState = true;
    
    // Track which conditions are currently active
    let enabledByLoad = false;
    let enabledByVoltage = false; 
    let enabledBySoC = false;
    let enabledByTime = false;
    
    // Track battery protection state
    let batteryProtectionActive = false;
    
    // Track emergency battery protection (cannot be overridden)
    let emergencyProtectionActive = false;
    
    // Timers for condition evaluation
    let loadEnableTimer = null;
    let voltageEnableTimer = null;
    let socEnableTimer = null;
    
    // Timer for relay disable delay
    let disableTimer = null;
    
    // Startup grace period
    let startupGraceTimer = null;
  
    // Get plugin configuration with defaults
    function getConfig() {
      const config = app.readPluginOptions();
      
      // Set battery-specific defaults based on type
      let defaults = {};
      switch (config.batteryType || 'li-ncm-15s') {
        case 'li-ncm-15s':
          defaults = {
            voltageThresholds: {
              lowVoltageEnable: 50.83,
              lowVoltageDisable: 53.1,
              highVoltageProtection: 61.5,
              emergencyVoltage: 63.0
            }
          };
          break;
        case 'lifepo4-16s':
          defaults = {
            voltageThresholds: {
              lowVoltageEnable: 49.6,   // 3.1V per cell = 9% SoC (second flat area ends)
              lowVoltageDisable: 51.0,  // 3.188V per cell = 30% SoC (flat area ends)  
              highVoltageProtection: 54.4, // 3.4V per cell = 97.5% SoC (aggressive rise starts)
              emergencyVoltage: 55.2    // 3.45V per cell = practical full charge limit
            }
          };
          break;
      }

      const finalConfig = {
        batteryType: config.batteryType || 'li-ncm-15s',
        loadThresholds: {
          enableWatts: config.loadThresholds?.enableWatts || 2500,
          disableWatts: config.loadThresholds?.disableWatts || 1750
        },
        voltageThresholds: defaults.voltageThresholds,
        socThresholds: {
          lowSocEnable: config.socThresholds?.lowSocEnable || 10,
          lowSocDisable: config.socThresholds?.lowSocDisable || 30,
          highSocProtection: config.socThresholds?.highSocProtection || 95
        },
        scheduleSettings: {
          timezone: config.scheduleSettings?.timezone || 'Europe/London',
          startHour: config.scheduleSettings?.startHour || 0,
          endHour: config.scheduleSettings?.endHour || 6
        }
      };

      // Validate configuration for safety
      if (finalConfig.loadThresholds.enableWatts <= finalConfig.loadThresholds.disableWatts) {
        log('warn', `Invalid load thresholds - enable (${finalConfig.loadThresholds.enableWatts}W) must be > disable (${finalConfig.loadThresholds.disableWatts}W), using defaults`);
        finalConfig.loadThresholds.enableWatts = 2500;
        finalConfig.loadThresholds.disableWatts = 1750;
      }
      
      if (finalConfig.socThresholds.lowSocEnable >= finalConfig.socThresholds.lowSocDisable) {
        log('warn', `Invalid SoC thresholds - enable (${finalConfig.socThresholds.lowSocEnable}%) must be < disable (${finalConfig.socThresholds.lowSocDisable}%), using defaults`);
        finalConfig.socThresholds.lowSocEnable = 10;
        finalConfig.socThresholds.lowSocDisable = 30;
      }
      
      if (finalConfig.voltageThresholds.lowVoltageEnable >= finalConfig.voltageThresholds.lowVoltageDisable) {
        log('warn', 'Invalid voltage thresholds detected, using battery defaults');
        finalConfig.voltageThresholds = defaults.voltageThresholds;
      }

      return finalConfig;
    }

    // Calculate SoC from voltage based on battery type
    function calculateSoC(voltage, batteryType) {
      switch (batteryType) {
        case 'li-ncm-15s':
          // Li-NCM 15S (55.5V nominal) - based on provided discharge curve
          if (voltage >= 63) return 100;
          else if (voltage >= 60.0) return 90 + ((voltage - 60.0) / (63.0 - 60.0)) * 10; // 90-100%
          else if (voltage >= 58.0) return 80 + ((voltage - 58.0) / (60.0 - 58.0)) * 10; // 80-90%
          else if (voltage >= 56.75) return 70 + ((voltage - 56.75) / (58.0 - 56.75)) * 10; // 70-80%
          else if (voltage >= 55.5) return 60 + ((voltage - 55.5) / (56.75 - 55.5)) * 10; // 60-70%
          else if (voltage >= 54.4) return 50 + ((voltage - 54.4) / (55.5 - 54.4)) * 10; // 50-60%
          else if (voltage >= 53.75) return 40 + ((voltage - 53.75) / (54.4 - 53.75)) * 10; // 40-50%
          else if (voltage >= 53.1) return 30 + ((voltage - 53.1) / (53.75 - 53.1)) * 10; // 30-40%
          else if (voltage >= 52.2) return 20 + ((voltage - 52.2) / (53.1 - 52.2)) * 10; // 20-30%
          else if (voltage >= 50.83) return 10 + ((voltage - 50.83) / (52.2 - 50.83)) * 10; // 10-20%
          else if (voltage >= 42.5) return 0 + ((voltage - 42.5) / (50.83 - 42.5)) * 10; // 0-10%
          else return 0;

        case 'lifepo4-16s':
          // LiFePO4 16S (51.2V nominal) - based on real discharge/charge curve data
          // Per cell voltages × 16 for 16S pack
          if (voltage >= 58.4) return 100;        // 3.65V per cell - full charge
          else if (voltage >= 54.4) return 97.5 + ((voltage - 54.4) / (58.4 - 54.4)) * 2.5;   // 97.5-100% (aggressive rise)
          else if (voltage >= 54.096) return 92.7 + ((voltage - 54.096) / (54.4 - 54.096)) * 4.8; // 92.7-97.5% (second flat ends)
          else if (voltage >= 53.2) return 27.3 + ((voltage - 53.2) / (54.096 - 53.2)) * 65.4;   // 27.3-92.7% (long flat area)
          else if (voltage >= 51.2) return 5.5 + ((voltage - 51.2) / (53.2 - 51.2)) * 21.8;     // 5.5-27.3% (first flat part)
          else if (voltage >= 51.008) return 9.0 + ((voltage - 51.008) / (51.2 - 51.008)) * -3.5; // 9-5.5% (transition zone)
          else if (voltage >= 49.6) return 3.6 + ((voltage - 49.6) / (51.008 - 49.6)) * 5.4;    // 3.6-9% (second flat area)
          else if (voltage >= 48.0) return 0 + ((voltage - 48.0) / (49.6 - 48.0)) * 3.6;        // 0-3.6% (aggressive drop)
          else return 0;

        default:
          // Fallback to Li-NCM calculation if battery type not recognized
          if (voltage >= 63) return 100;
          else if (voltage >= 60.0) return 90 + ((voltage - 60.0) / (63.0 - 60.0)) * 10;
          else if (voltage >= 58.0) return 80 + ((voltage - 58.0) / (60.0 - 58.0)) * 10;
          else if (voltage >= 56.75) return 70 + ((voltage - 56.75) / (58.0 - 56.75)) * 10;
          else if (voltage >= 55.5) return 60 + ((voltage - 55.5) / (56.75 - 55.5)) * 10;
          else if (voltage >= 54.4) return 50 + ((voltage - 54.4) / (55.5 - 54.4)) * 10;
          else if (voltage >= 53.75) return 40 + ((voltage - 53.75) / (54.4 - 53.75)) * 10;
          else if (voltage >= 53.1) return 30 + ((voltage - 53.1) / (53.75 - 53.1)) * 10;
          else if (voltage >= 52.2) return 20 + ((voltage - 52.2) / (53.1 - 52.2)) * 10;
          else if (voltage >= 50.83) return 10 + ((voltage - 50.83) / (52.2 - 50.83)) * 10;
          else if (voltage >= 42.5) return 0 + ((voltage - 42.5) / (50.83 - 42.5)) * 10;
          else return 0;
      }
    }
  
    // Helper function to safely send relay commands
    function setRelayState(state, reason) {
      try {
        app.handleMessage('smart-grid-controller', {
          updates: [{
            values: [{
              path: 'electrical.switches.relay1.state',
              value: state
            }]
          }]
        });
      } catch (error) {
        log('error', `Error setting relay state to ${state} (${reason}) - ${error.message}`);
      }
    }
  
    return {
      id: 'smart-grid-controller',
      name: 'Smart Grid Controller',
      description: 'Intelligent AC grid management for Victron MultiPlus II with load-based switching, battery protection, and scheduled charging',
  
      start: function() {
        // Enable grid immediately on startup
        log('info', 'Grid AC ENABLED on startup - 30s grace period active');
        setRelayState(1, 'Startup - 30s grace period active');
        
        // Start 30-second startup grace period
        startupGraceTimer = setTimeout(() => {
          startupGraceTimer = null;
          log('info', 'Startup grace period ended - normal condition evaluation active');
        }, 30000);
  
        // Subscribe to Victron data
        app.signalk.on('delta', (delta) => {
          try {
            const voltage = app.getSelfPath('electrical.chargers.275.voltage')?.value || 0;
            const load = app.getSelfPath('electrical.inverters.275.acout.power')?.value || 0;
            
            // Validate data - skip processing if values are clearly invalid
            if (voltage < 0 || voltage > 100 || load < 0 || load > 50000) {
              log('warn', `Invalid data - Voltage: ${voltage}V, Load: ${load}W - skipping cycle`);
              return;
            }
            
            const config = getConfig();

            // Calculate SoC from voltage based on battery type
            let soc = calculateSoC(voltage, config.batteryType);
            
            // Ensure SoC is within valid range
            soc = Math.max(0, Math.min(100, soc));

            // Get time in configured timezone with error handling
            let localTime, hours, isChargingWindow;
            try {
              const now = new Date();
              localTime = new Date(now.toLocaleString("en-US", {timeZone: config.scheduleSettings.timezone}));
              hours = localTime.getHours();
              isChargingWindow = (hours >= config.scheduleSettings.startHour && hours < config.scheduleSettings.endHour);
            } catch (timezoneError) {
              log('warn', `Invalid timezone ${config.scheduleSettings.timezone}, falling back to local time`);
              localTime = new Date();
              hours = localTime.getHours();
              isChargingWindow = (hours >= config.scheduleSettings.startHour && hours < config.scheduleSettings.endHour);
            }
  
            // Condition 1: Load > threshold for 3 seconds (enable) / < threshold (disable immediately)
            if (load > config.loadThresholds.enableWatts && !enabledByLoad) {
              if (!loadEnableTimer) {
                loadEnableTimer = setTimeout(() => {
                  enabledByLoad = true;
                  loadEnableTimer = null;
                }, 3000);
              }
            } else if (load < config.loadThresholds.disableWatts) {
              enabledByLoad = false;
              clearTimeout(loadEnableTimer);
              loadEnableTimer = null;
            } else if (load >= config.loadThresholds.disableWatts && load <= config.loadThresholds.enableWatts && loadEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(loadEnableTimer);
              loadEnableTimer = null;
            }
  
            // Condition 2: Voltage < threshold for 3 seconds (enable) / > threshold (disable immediately)
            if (voltage < config.voltageThresholds.lowVoltageEnable && !enabledByVoltage) {
              if (!voltageEnableTimer) {
                voltageEnableTimer = setTimeout(() => {
                  enabledByVoltage = true;
                  voltageEnableTimer = null;
                }, 3000);
              }
            } else if (voltage > config.voltageThresholds.lowVoltageDisable) {
              enabledByVoltage = false;
              clearTimeout(voltageEnableTimer);
              voltageEnableTimer = null;
            } else if (voltage >= config.voltageThresholds.lowVoltageEnable && voltage <= config.voltageThresholds.lowVoltageDisable && voltageEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(voltageEnableTimer);
              voltageEnableTimer = null;
            }
  
            // Condition 3: SoC < threshold for 3 seconds (enable) / > threshold (disable immediately)
            if (soc < config.socThresholds.lowSocEnable && !enabledBySoC) {
              if (!socEnableTimer) {
                socEnableTimer = setTimeout(() => {
                  enabledBySoC = true;
                  socEnableTimer = null;
                }, 3000);
              }
            } else if (soc > config.socThresholds.lowSocDisable) {
              enabledBySoC = false;
              clearTimeout(socEnableTimer);
              socEnableTimer = null;
            } else if (soc >= config.socThresholds.lowSocEnable && soc <= config.socThresholds.lowSocDisable && socEnableTimer) {
              // In hysteresis zone - clear timer but don't change state
              clearTimeout(socEnableTimer);
              socEnableTimer = null;
            }
  
            // Condition 4: Scheduled charging window (immediate enable/disable)
            enabledByTime = isChargingWindow;
  
            // Battery protection with hysteresis: configurable thresholds
            const highVoltageRecovery = config.voltageThresholds.highVoltageProtection - 1.5; // 1.5V hysteresis
            const highSocRecovery = config.socThresholds.highSocProtection - 5; // 5% hysteresis
            
            if ((voltage > config.voltageThresholds.highVoltageProtection || soc > config.socThresholds.highSocProtection) && !batteryProtectionActive) {
              batteryProtectionActive = true;
            } else if (voltage < highVoltageRecovery && soc < highSocRecovery && batteryProtectionActive) {
              batteryProtectionActive = false;
            }
            
            // Emergency battery protection: configurable emergency voltage
            const emergencyRecovery = config.voltageThresholds.emergencyVoltage - 1.0; // 1V hysteresis
            if (voltage > config.voltageThresholds.emergencyVoltage && !emergencyProtectionActive) {
              emergencyProtectionActive = true;
            } else if (voltage < emergencyRecovery && emergencyProtectionActive) {
              emergencyProtectionActive = false;
            }

            // Determine if any condition is active
            const anyConditionActive = enabledByLoad || enabledByVoltage || enabledBySoC || enabledByTime;
            
            // Battery protection overrides other conditions (unless load condition active)
            const batteryProtectionTriggered = batteryProtectionActive && !enabledByLoad;
            
            // Emergency protection overrides everything (including load condition)
            const emergencyProtectionTriggered = emergencyProtectionActive;

            // Handle relay control
            if (emergencyProtectionTriggered && relayState) {
              // Emergency protection triggered - disable grid immediately, no exceptions
              clearTimeout(disableTimer);
              disableTimer = null;
              relayState = false;
              
              log('info', `Emergency protection triggered - Critical voltage ${voltage.toFixed(2)}V > ${config.voltageThresholds.emergencyVoltage}V`);
              
              setRelayState(0, 'Emergency protection triggered');
            } else if (anyConditionActive && !relayState && !batteryProtectionTriggered && !emergencyProtectionTriggered) {
              // Conditions want to enable grid and no protection active - turn on immediately
              clearTimeout(disableTimer);
              disableTimer = null;
              relayState = true;
              
              // Log which conditions are active
              const activeConditions = [];
              if (enabledByLoad) activeConditions.push(`Load: ${load.toFixed(1)}W`);
              if (enabledByVoltage) activeConditions.push(`Voltage: ${voltage.toFixed(2)}V`);
              if (enabledBySoC) activeConditions.push(`SoC: ${soc.toFixed(1)}%`);
              if (enabledByTime) activeConditions.push(`Time: ${hours.toString().padStart(2, '0')}:${localTime.getMinutes().toString().padStart(2, '0')}`);
              
              log('info', `Active conditions: ${activeConditions.join(', ')}`);
              
              setRelayState(1, `Active conditions: ${activeConditions.join(', ')}`);
            } else if (batteryProtectionTriggered && relayState) {
              // Battery protection triggered - disable grid immediately
              clearTimeout(disableTimer);
              disableTimer = null;
              relayState = false;
              
              const protectionReasons = [];
              if (voltage > config.voltageThresholds.highVoltageProtection) protectionReasons.push(`High voltage: ${voltage.toFixed(2)}V > ${config.voltageThresholds.highVoltageProtection}V`);
              if (soc > config.socThresholds.highSocProtection) protectionReasons.push(`High SoC: ${soc.toFixed(1)}% > ${config.socThresholds.highSocProtection}%`);
              
              log('info', `Battery protection: ${protectionReasons.join(', ')} (Load condition: ${enabledByLoad ? 'Active' : 'Inactive'})`);
              
              setRelayState(0, `Battery protection: ${protectionReasons.join(', ')} (Load condition: ${enabledByLoad ? 'Active' : 'Inactive'})`);
            } else if (!anyConditionActive && relayState && !startupGraceTimer) {
              // No conditions want grid enabled and startup grace period is over - start 30 second disable timer
              if (!disableTimer) {
                disableTimer = setTimeout(() => {
                  relayState = false;
                  disableTimer = null;
                  
                  // Log which conditions were cleared
                  const clearedConditions = [];
                  if (!enabledByLoad) clearedConditions.push(`Load: ${load.toFixed(1)}W < ${config.loadThresholds.disableWatts}W`);
                  if (!enabledByVoltage) clearedConditions.push(`Voltage: ${voltage.toFixed(2)}V > ${config.voltageThresholds.lowVoltageDisable}V`);
                  if (!enabledBySoC) clearedConditions.push(`SoC: ${soc.toFixed(1)}% > ${config.socThresholds.lowSocDisable}%`);
                  if (!enabledByTime) clearedConditions.push(`Time: ${hours.toString().padStart(2, '0')}:${localTime.getMinutes().toString().padStart(2, '0')} outside ${config.scheduleSettings.startHour.toString().padStart(2, '0')}:00-${config.scheduleSettings.endHour.toString().padStart(2, '0')}:00`);
                  
                  log('info', `Cleared conditions: ${clearedConditions.join(', ')}`);
                  
                  setRelayState(0, `Cleared conditions: ${clearedConditions.join(', ')}`);
                }, 30000);
              }
            } else if (anyConditionActive && relayState && !batteryProtectionTriggered && !emergencyProtectionTriggered) {
              // Conditions still want grid enabled and no protection active - clear any pending disable timer
              clearTimeout(disableTimer);
              disableTimer = null;
            }
          } catch (error) {
            log('error', `Error processing data - ${error.message}`);
          }
        });
  
        // Map Signal K relay state to Cerbo GX Relay 1
        app.registerPutHandler('v1', 'electrical.switches.relay1.state', (context, path, value) => {
          try {
            app.putSelfPath('electrical.switches.relay1.state', value);
            if (app.dbus && app.dbus.setValue) {
              app.dbus.setValue('com.victronenergy.system', '/Relay/1/State', value);
            } else {
              log('warn', 'D-Bus not available - relay state not updated on Cerbo GX');
            }
          } catch (error) {
            log('error', `Error setting relay state - ${error.message}`);
          }
        });
      },
  
      stop: function() {
        clearTimeout(loadEnableTimer);
        clearTimeout(voltageEnableTimer);
        clearTimeout(socEnableTimer);
        clearTimeout(disableTimer);
        clearTimeout(startupGraceTimer);
      }
    };
  };