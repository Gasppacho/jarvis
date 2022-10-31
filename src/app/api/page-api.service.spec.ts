/* tslint:disable:no-unused-variable */

import { TestBed, async, inject } from '@angular/core/testing';
import { PageApiService } from './page-api.service';

describe('Service: PageApi', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [PageApiService]
    });
  });

  it('should ...', inject([PageApiService], (service: PageApiService) => {
    expect(service).toBeTruthy();
  }));
});
