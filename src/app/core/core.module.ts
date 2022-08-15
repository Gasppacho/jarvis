import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationComponent } from './navigation/navigation.component';
import { QuickActionModule } from './quick-action/quick-action.module';
import { QuickActionComponent } from './quick-action/quick-action.component';
import { MatIconModule } from '@angular/material/icon';
import { RouterModule } from '@angular/router';

@NgModule({
	imports: [
		CommonModule,
		RouterModule,
		QuickActionModule,
		MatIconModule
	],
	declarations: [NavigationComponent],
	exports: [NavigationComponent, QuickActionComponent]
})
export class CoreModule { }
