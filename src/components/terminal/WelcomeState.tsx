import { Component, Show } from "solid-js";
import { appVersion } from "../../lib/version";

export const WelcomeState: Component = () => {
  return (
    <div class="welcome-state">
      <div class="welcome-title">Rain</div>
      <Show when={appVersion()}><div class="welcome-version">v{appVersion()}</div></Show>
      <pre class="welcome-art">{`
                                    
                     ###                    
                    #####                   
                  ########                  
                 ###########                
                #############               
              #################             
             ###################            
           #######################          
          #########################         
         ###########################        
       ##############################       
      #####  #########################      
      ######    #######################     
     ##########    #####################    
     ############    ###################    
     #########    ######################    
     ######    #########################    
     ################           ########    
      #################################     
       ###############################      
        #############################       
         ###########################        
           #######################          
              #################             
                   #######                  
                                            

`}</pre>
      <div class="welcome-shortcuts">
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+T</span>
          <span>New tab</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+K</span>
          <span>Clear</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+,</span>
          <span>Settings</span>
        </div>
      </div>
    </div>
  );
};
