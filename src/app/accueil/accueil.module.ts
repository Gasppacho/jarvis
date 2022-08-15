import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccueilComponent } from './accueil.component';
import { AccueilRoutes } from './accueil.routing';

@NgModule({
	imports: [
		CommonModule,
		AccueilRoutes
	],
	declarations: [AccueilComponent]
})
export class AccueilModule { }
